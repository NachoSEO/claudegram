/**
 * OpenAI Agents SDK provider.
 *
 * Uses @openai/agents with Agent + run() for streaming and tool execution.
 * Multi-turn context is maintained via local message history — the Codex
 * backend does not support OpenAIConversationsSession or previousResponseId.
 */

import { run, Agent, user, assistant } from '@openai/agents';
import { setDefaultOpenAIClient } from '@openai/agents-openai';
import type { RunStreamEvent, AgentInputItem } from '@openai/agents';

import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { setActiveQuery, clearActiveQuery, isCancelled } from '../claude/request-queue.js';
import { eventBus } from '../dashboard/event-bus.js';
import { contextMonitor } from '../claude/context-monitor.js';
import { stripReasoningSummary } from './system-prompt.js';
import { AgentCache } from './openai-agent-cache.js';
import type { HistoryItem } from './openai-agent-cache.js';
import { hasOAuthTokens, getAuthenticatedClient } from './openai-auth.js';
import { mcpManager } from './openai-mcp.js';

import type {
  AgentProvider,
  AgentUsage,
  AgentResponse,
  AgentOptions,
  Cancellable,
} from './types.js';

/** Context window sizes for OpenAI models (Feb 2026). */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.2': 400_000,
  'gpt-5.2-pro': 400_000,
  'gpt-5.1': 400_000,
  'gpt-5.1-codex': 400_000,
  'gpt-5.1-codex-mini': 400_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  'gpt-5.2-codex': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
};

const DEFAULT_CONTEXT_WINDOW = 400_000;

/** Available OpenAI models grouped by tier for /model command display. */
export const OPENAI_MODEL_TIERS = {
  flagship: ['gpt-5.2', 'gpt-5.2-pro'] as const,
  standard: ['gpt-5.1', 'gpt-5'] as const,
  efficient: ['gpt-5-mini', 'gpt-5-nano'] as const,
  codex: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'] as const,
  longContext: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] as const,
  legacy: ['gpt-4o', 'gpt-4o-mini'] as const,
} as const;

export const VALID_OPENAI_MODELS = new Set(Object.keys(MODEL_CONTEXT_WINDOWS));

function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/** Wraps an AbortController into the Cancellable interface for request-queue. */
class AbortCancellable implements Cancellable {
  constructor(private readonly controller: AbortController) {}

  async interrupt(): Promise<void> {
    this.controller.abort();
  }
}

/**
 * Mutable ref for per-turn tool callbacks.
 * Lifecycle hooks are registered once on the Agent, but read from this ref
 * each invocation so they always target the current turn's callbacks.
 */
interface ToolCallbackRef {
  onToolStart?: AgentOptions['onToolStart'];
  onToolEnd?: AgentOptions['onToolEnd'];
  toolsUsed: string[];
  chatId: number;
}


export class OpenAIProvider implements AgentProvider {
  private readonly agentCache = new AgentCache();
  private readonly chatModels = new Map<number, string>();
  private readonly chatUsageCache = new Map<number, AgentUsage>();
  private readonly toolCallbackRefs = new Map<number, ToolCallbackRef>();

  private authMode: 'api-key' | 'oauth' = 'api-key';

  constructor() {
    if (config.OPENAI_API_KEY) {
      this.authMode = 'api-key';
      console.log(`[OpenAI] Auth: API key, default model: ${config.OPENAI_DEFAULT_MODEL}`);
    } else if (hasOAuthTokens()) {
      this.authMode = 'oauth';
      console.log(`[OpenAI] Auth: OAuth (ChatGPT Pro), default model: ${config.OPENAI_DEFAULT_MODEL}`);
    } else {
      throw new Error(
        '[OpenAI] No auth configured. Either:\n' +
        '  1. Set OPENAI_API_KEY in .env, or\n' +
        '  2. Log in with Codex CLI: codex --login',
      );
    }
  }

  /**
   * Initialize the OAuth client if using Pro subscription auth.
   * Must be called before first send() — called lazily on first use.
   */
  private lastOAuthToken: string | undefined;
  /**
   * Ensure OAuth client is set and token is fresh.
   * Re-injects client when token changes (after refresh).
   */
  private async ensureOAuthClient(): Promise<void> {
    if (this.authMode !== 'oauth') return;
    const client = await getAuthenticatedClient();
    if (!client) {
      throw new Error(
        '[OpenAI] OAuth tokens expired or invalid. Re-run: codex --login',
      );
    }
    // Only re-inject if token changed (initial set or post-refresh)
    const currentToken = (client as unknown as { apiKey: string }).apiKey;
    if (currentToken !== this.lastOAuthToken) {
      setDefaultOpenAIClient(client);
      this.lastOAuthToken = currentToken;
    }
  }

  async send(
    chatId: number,
    message: string | AgentInputItem[],
    options: AgentOptions,
  ): Promise<AgentResponse> {
    const { onProgress, onToolStart, onToolEnd, abortController, command, model, platform } = options;

    const promptForLog = Array.isArray(message) ? '[complex-input]' : message;
    console.log(`[OpenAI] send() chatId=${chatId} prompt="${promptForLog.slice(0, 120)}..." command=${command || 'chat'}`);

    // Ensure OAuth client is initialized (no-op for API key auth)
    await this.ensureOAuthClient();

    const session = sessionManager.getSession(chatId);
    if (!session) {
      throw new Error('No active session. Use /project to set working directory.');
    }

    sessionManager.updateActivity(chatId, promptForLog);

    let prompt = promptForLog;
    if (command === 'explore' && !Array.isArray(message)) {
      prompt = `Explore the codebase and answer: ${message}`;
    }

    const effectiveModel = model || this.chatModels.get(chatId) || config.OPENAI_DEFAULT_MODEL;
    const contextWindow = getContextWindow(effectiveModel);
    // Dangerous tools are controlled only by DANGEROUS_MODE, regardless of auth mode.
    // This allows full local tool access even when using OAuth auth.
    const dangerousToolsEnabled = config.DANGEROUS_MODE;

    console.log(`[OpenAI] model=${effectiveModel} dangerous=${dangerousToolsEnabled} cwd=${session.workingDirectory}`);

    // Get connected MCP servers (ShieldCortex memory)
    const mcpServers = await mcpManager.getServers();
    console.log(`[OpenAI] MCP servers: ${mcpServers.length > 0 ? mcpServers.map(s => s.name).join(', ') : 'none'}`);

    // Get or create a cached Agent instance (invalidates on model/cwd change)
    const agentState = this.agentCache.getOrCreate(
      chatId,
      effectiveModel,
      session.workingDirectory,
      platform,
      dangerousToolsEnabled,
      mcpServers,
      session.conversationId,
    );

    const agentStartTime = Date.now();
    const controller = abortController || new AbortController();
    const toolsUsed: string[] = [];

    // Update the mutable callback ref so lifecycle hooks target THIS turn
    const callbackRef: ToolCallbackRef = { onToolStart, onToolEnd, toolsUsed, chatId };
    this.toolCallbackRefs.set(chatId, callbackRef);

    eventBus.emit('agent:start', {
      chatId,
      model: effectiveModel,
      prompt: prompt.slice(0, 200),
      timestamp: agentStartTime,
    });

    // Expose cancellable for request-queue
    setActiveQuery(chatId, new AbortCancellable(controller));

    let fullText = '';
    let resultUsage: AgentUsage | undefined;

    try {
      // Register lifecycle hooks (idempotent — only attaches once per Agent)
      this.ensureToolHooks(agentState.agent);

      // Build input: accumulated history + new user message
      const input = Array.isArray(message)
        ? this.buildInputWithItems(agentState.history, message)
        : this.buildInput(agentState.history, prompt);

      // Run with streaming — no session, local history only
      console.log(`[OpenAI] Starting run() with ${input.length} input items`);
      const result = await run(agentState.agent, input, {
        stream: true,
        signal: controller.signal,
        // Avoid "Max turns (10) exceeded" from @openai/agents runner.
        // We treat turns as unlimited by default.
        //
        // Note: the Agents SDK expects a finite number. If you truly want
        // "no limit", the practical approach is to set an extremely high cap.
        //
        // Env overrides:
        //   - CLAUDEGRAM_MAX_TURNS=unlimited|infinite|none|0  -> huge cap
        //   - CLAUDEGRAM_MAX_TURNS=<number>                   -> that cap
        maxTurns: (() => {
          const raw = (process.env.CLAUDEGRAM_MAX_TURNS ?? '').trim().toLowerCase();
          if (!raw || raw === '0' || raw === 'none' || raw === 'infinite' || raw === 'unlimited') {
            return Number.MAX_SAFE_INTEGER;
          }
          const parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
        })(),
      } as Parameters<typeof run>[2]);

      // The stream: true overload returns StreamedRunResult
      const streamed = result as AsyncIterable<RunStreamEvent> & {
        completed: Promise<void>;
        newItems: Array<{ type: string; rawItem?: Record<string, unknown> }>;
        finalOutput?: unknown;
        state: { usage: { inputTokens: number; outputTokens: number; inputTokensDetails: Array<Record<string, number>> } };
      };

      // Consume the stream for text deltas and tool call notifications
      for await (const event of streamed) {
        this.handleStreamEvent(event, (delta) => {
          fullText += delta;
          onProgress?.(fullText);
        }, chatId);
      }

      // Wait for the run to fully complete
      await streamed.completed;
      console.log(`[OpenAI] Stream completed, ${fullText.length} chars response`);

      // Extract tools used from newItems
      for (const item of streamed.newItems) {
        if (item.type === 'tool_call_item' && item.rawItem) {
          const raw = item.rawItem;
          if ('name' in raw && typeof raw.name === 'string' && !toolsUsed.includes(raw.name)) {
            toolsUsed.push(raw.name);
          }
        }
      }
      console.log(`[OpenAI] newItems: ${streamed.newItems.length} items, types: ${[...new Set(streamed.newItems.map(i => i.type))].join(', ') || 'none'}`);
      console.log(`[OpenAI] Tools used: ${toolsUsed.length > 0 ? toolsUsed.join(', ') : 'none'}`);

      // If finalOutput is available and fullText is empty (edge case), use it
      if (!fullText && streamed.finalOutput) {
        fullText = String(streamed.finalOutput);
      }

      // Update local conversation history
      if (!Array.isArray(message)) {
        agentState.history.push({ role: 'user', content: prompt });
      }
      if (fullText) {
        agentState.history.push({ role: 'assistant', content: fullText });
      }

      // Trim history to avoid exceeding context window
      this.trimHistory(agentState.history, contextWindow);

      // Persist OpenAI history so /continue and /resume restore context after restart
      this.agentCache.saveHistory(chatId, session.conversationId, agentState.history);

      // Extract usage from the run
      const usage = streamed.state.usage;
      const turnCount = this.agentCache.incrementTurn(chatId);

      // Sum cached_tokens from inputTokensDetails across all requests
      let cacheReadTokens = 0;
      for (const details of usage.inputTokensDetails) {
        cacheReadTokens += details['cached_tokens'] ?? 0;
      }

      resultUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        totalCostUsd: 0,
        contextWindow,
        numTurns: turnCount,
        model: effectiveModel,
      };

    } catch (error: unknown) {
      if (isCancelled(chatId) || controller.signal.aborted) {
        eventBus.emit('agent:complete', {
          chatId,
          text: '✅ Cancelled',
          toolsUsed,
          durationMs: Date.now() - agentStartTime,
          timestamp: Date.now(),
        });
        return {
          text: '✅ Successfully cancelled - no tools or agents in process.',
          toolsUsed,
        };
      }

      console.error('[OpenAI] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      eventBus.emit('agent:error', { chatId, error: errorMessage, timestamp: Date.now() });
      eventBus.emit('agent:complete', {
        chatId,
        text: '',
        toolsUsed,
        durationMs: Date.now() - agentStartTime,
        timestamp: Date.now(),
      });
      throw new Error(`OpenAI error: ${errorMessage}`);
    } finally {
      clearActiveQuery(chatId);
      this.toolCallbackRefs.delete(chatId);
    }

    // Cache usage
    if (resultUsage) {
      this.chatUsageCache.set(chatId, resultUsage);
    }

    const durationMs = Date.now() - agentStartTime;
    console.log(`[OpenAI] Complete: ${fullText.length} chars, ${toolsUsed.length} tools [${toolsUsed.join(', ')}], ${durationMs}ms`);
    if (resultUsage) {
      console.log(`[OpenAI] Usage: ${resultUsage.inputTokens} in / ${resultUsage.outputTokens} out / ${resultUsage.cacheReadTokens} cached`);
    }

    eventBus.emit('agent:complete', {
      chatId,
      text: fullText.slice(0, 500),
      toolsUsed,
      usage: resultUsage,
      durationMs,
      timestamp: Date.now(),
    });

    return {
      text: stripReasoningSummary(fullText) || 'No response from OpenAI.',
      toolsUsed,
      usage: resultUsage,
    };
  }

  /**
   * Build run() input as AgentInputItem[].
   *
   * Codex responses require input to be a list (not a plain string).
   * We preserve history as explicit user/assistant message items.
   */
  private buildInput(
    history: HistoryItem[],
    newMessage: string,
  ): AgentInputItem[] {
    const items: AgentInputItem[] = history.map((item) =>
      item.role === 'user' ? user(item.content) : assistant(item.content),
    );
    items.push(user(newMessage));
    return items;
  }

  private buildInputWithItems(history: HistoryItem[], newItems: AgentInputItem[]): AgentInputItem[] {
    const items: AgentInputItem[] = history.map((item) =>
      item.role === 'user' ? user(item.content) : assistant(item.content),
    );
    items.push(...newItems);
    return items;
  }


  /**
   * Trim conversation history to stay within context limits.
   * Uses a rough 4 chars/token estimate, keeping the most recent messages.
   */
  private trimHistory(history: HistoryItem[], contextWindow: number): void {
    const maxChars = contextWindow * 2; // ~50% of context for history (4 chars/token, halved)
    let totalChars = 0;
    for (const item of history) {
      totalChars += item.content.length;
    }
    while (totalChars > maxChars && history.length > 2) {
      const removed = history.shift();
      if (removed) totalChars -= removed.content.length;
    }
  }

  /**
   * Process a single stream event, extracting text deltas and tool call notifications.
   *
   * The SDK's `agent_tool_start` lifecycle hooks don't always fire for MCP tools,
   * so we also detect tool calls from `run_item_stream_event` as a reliable backup.
   */
  private handleStreamEvent(
    event: RunStreamEvent,
    onDelta: (delta: string) => void,
    chatId: number,
  ): void {
    // Log non-text-delta events for visibility (text deltas are too noisy)
    if (event.type === 'run_item_stream_event') {
      const se = event as { name: string; item?: { type: string; rawItem?: Record<string, unknown> } };
      const toolName = se.item?.rawItem && typeof se.item.rawItem.name === 'string' ? ` tool=${se.item.rawItem.name}` : '';
      console.log(`[OpenAI Stream] ${se.name} (${se.item?.type || 'unknown'})${toolName}`);
    } else if (event.type === 'raw_model_stream_event' && event.data.type !== 'output_text_delta') {
      // Log raw events that aren't text deltas (function calls, reasoning, etc.)
      const rawType = event.data.type;
      console.log(`[OpenAI Raw] ${rawType}`);
    }

    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      const data = event.data;
      if ('delta' in data && typeof data.delta === 'string') {
        onDelta(data.delta);
      }
    }

    // Detect tool calls from stream items (reliable for both local and MCP tools)
    if (event.type === 'run_item_stream_event') {
      const streamEvent = event as { name: string; item: { type: string; rawItem?: Record<string, unknown> } };
      const { name, item } = streamEvent;

      if (name === 'tool_call_item_created' && item?.type === 'tool_call_item' && item.rawItem) {
        const raw = item.rawItem;
        const toolName = typeof raw.name === 'string' ? raw.name : 'unknown';
        console.log(`[OpenAI Stream] Tool call: ${toolName}`);
        let toolInput: Record<string, unknown> | undefined;
        if (typeof raw.arguments === 'string') {
          try { toolInput = JSON.parse(raw.arguments) as Record<string, unknown>; } catch { /* partial args */ }
        }

        const ref = this.toolCallbackRefs.get(chatId);
        if (ref) {
          if (!ref.toolsUsed.includes(toolName)) {
            ref.toolsUsed.push(toolName);
          }
          ref.onToolStart?.(toolName, toolInput);
          eventBus.emit('agent:tool_start', {
            chatId,
            toolName,
            input: toolInput,
            timestamp: Date.now(),
          });
        }
      }

      if (name === 'tool_output_item_created') {
        const ref = this.toolCallbackRefs.get(chatId);
        if (ref) {
          ref.onToolEnd?.();
          eventBus.emit('agent:tool_end', {
            chatId,
            toolName: 'unknown',
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  /**
   * Attach lifecycle hooks to the Agent for tool start/end events.
   * Hooks are registered once per Agent instance. They read from the
   * mutable `toolCallbackRefs` map so callbacks are always current.
   */
  private readonly hookedAgents = new WeakSet<Agent>();

  private ensureToolHooks(agent: Agent): void {
    if (this.hookedAgents.has(agent)) return;
    this.hookedAgents.add(agent);

    agent.on('agent_tool_start', (_ctx, tool, details) => {
      const callItem = details?.toolCall;
      const toolName = tool?.name || ('name' in callItem ? String(callItem.name) : 'unknown');
      const ref = this.findCallbackRefForAgent(agent);
      if (ref) {
        if (!ref.toolsUsed.includes(toolName)) {
          ref.toolsUsed.push(toolName);
        }
        let toolInput: Record<string, unknown> | undefined;
        if (callItem && 'arguments' in callItem && typeof callItem.arguments === 'string') {
          try { toolInput = JSON.parse(callItem.arguments) as Record<string, unknown>; } catch { /* ignore parse errors */ }
        }
        ref.onToolStart?.(toolName, toolInput);
        eventBus.emit('agent:tool_start', {
          chatId: ref.chatId,
          toolName,
          input: toolInput,
          timestamp: Date.now(),
        });
      }
    });

    agent.on('agent_tool_end', (_ctx, tool, _result, details) => {
      const callItem = details?.toolCall;
      const toolName = tool?.name || ('name' in callItem ? String(callItem.name) : 'unknown');
      const ref = this.findCallbackRefForAgent(agent);
      if (ref) {
        ref.onToolEnd?.();
        eventBus.emit('agent:tool_end', {
          chatId: ref.chatId,
          toolName,
          timestamp: Date.now(),
        });
      }
    });
  }

  /** Find the current tool callback ref for the chat that owns this Agent. */
  private findCallbackRefForAgent(agent: Agent): ToolCallbackRef | undefined {
    for (const [, ref] of this.toolCallbackRefs) {
      if (this.agentCache.getAgent(ref.chatId) === agent) {
        return ref;
      }
    }
    return undefined;
  }

  async clearConversation(chatId: number): Promise<void> {
    // Clear in-memory cache and also remove persisted history for the active session
    const session = sessionManager.getSession(chatId);
    if (session?.conversationId) {
      this.agentCache.deletePersistedHistory(chatId, session.conversationId);
    }

    this.agentCache.delete(chatId);
    this.chatUsageCache.delete(chatId);
    this.toolCallbackRefs.delete(chatId);
    contextMonitor.resetChat(chatId);
  }

  setModel(chatId: number, model: string): void {
    this.chatModels.set(chatId, model);
  }

  getModel(chatId: number): string {
    return this.chatModels.get(chatId) || config.OPENAI_DEFAULT_MODEL;
  }

  clearModel(chatId: number): void {
    this.chatModels.delete(chatId);
  }

  getCachedUsage(chatId: number): AgentUsage | undefined {
    return this.chatUsageCache.get(chatId);
  }

  isDangerousMode(): boolean {
    return config.DANGEROUS_MODE;
  }
}
