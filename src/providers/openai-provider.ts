/**
 * OpenAI Agents SDK provider.
 *
 * Uses @openai/agents with Agent + run() for streaming and tool execution.
 * Multi-turn context is maintained via local message history — the Codex
 * backend does not support OpenAIConversationsSession or previousResponseId.
 */

import { run, Agent } from '@openai/agents';
import { setDefaultOpenAIClient } from '@openai/agents-openai';
import type { RunStreamEvent } from '@openai/agents';

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
    message: string,
    options: AgentOptions,
  ): Promise<AgentResponse> {
    const { onProgress, onToolStart, onToolEnd, abortController, command, model, platform } = options;

    // Ensure OAuth client is initialized (no-op for API key auth)
    await this.ensureOAuthClient();

    const session = sessionManager.getSession(chatId);
    if (!session) {
      throw new Error('No active session. Use /project to set working directory.');
    }

    sessionManager.updateActivity(chatId, message);

    let prompt = message;
    if (command === 'explore') {
      prompt = `Explore the codebase and answer: ${message}`;
    }

    const effectiveModel = model || this.chatModels.get(chatId) || config.OPENAI_DEFAULT_MODEL;
    const contextWindow = getContextWindow(effectiveModel);
    const dangerousToolsEnabled = config.DANGEROUS_MODE && this.authMode !== 'oauth';

    // Get connected MCP servers (ShieldCortex memory)
    const mcpServers = await mcpManager.getServers();

    // Get or create a cached Agent instance (invalidates on model/cwd change)
    const agentState = this.agentCache.getOrCreate(
      chatId,
      effectiveModel,
      session.workingDirectory,
      platform,
      dangerousToolsEnabled,
      mcpServers,
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
      const input = this.buildInput(agentState.history, prompt);

      // Run with streaming — no session, local history only
      const result = await run(agentState.agent, input, {
        stream: true,
        signal: controller.signal,
      } as Parameters<typeof run>[2]);

      // The stream: true overload returns StreamedRunResult
      const streamed = result as AsyncIterable<RunStreamEvent> & {
        completed: Promise<void>;
        newItems: Array<{ type: string; rawItem?: Record<string, unknown> }>;
        finalOutput?: unknown;
        state: { usage: { inputTokens: number; outputTokens: number; inputTokensDetails: Array<Record<string, number>> } };
      };

      // Consume the stream for text deltas
      for await (const event of streamed) {
        this.handleStreamEvent(event, (delta) => {
          fullText += delta;
          onProgress?.(fullText);
        });
      }

      // Wait for the run to fully complete
      await streamed.completed;

      // Extract tools used from newItems
      for (const item of streamed.newItems) {
        if (item.type === 'tool_call_item' && item.rawItem) {
          const raw = item.rawItem;
          if ('name' in raw && typeof raw.name === 'string' && !toolsUsed.includes(raw.name)) {
            toolsUsed.push(raw.name);
          }
        }
      }

      // If finalOutput is available and fullText is empty (edge case), use it
      if (!fullText && streamed.finalOutput) {
        fullText = String(streamed.finalOutput);
      }

      // Update local conversation history
      agentState.history.push({ role: 'user', content: prompt });
      if (fullText) {
        agentState.history.push({ role: 'assistant', content: fullText });
      }

      // Trim history to avoid exceeding context window
      this.trimHistory(agentState.history, contextWindow);

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

    eventBus.emit('agent:complete', {
      chatId,
      text: fullText.slice(0, 500),
      toolsUsed,
      usage: resultUsage,
      durationMs: Date.now() - agentStartTime,
      timestamp: Date.now(),
    });

    return {
      text: stripReasoningSummary(fullText) || 'No response from OpenAI.',
      toolsUsed,
      usage: resultUsage,
    };
  }

  /**
   * Build the input string for run() from conversation history + new message.
   * Concatenates history into a single string prompt for the model.
   * The Agent's `instructions` (system prompt) is set separately.
   */
  private buildInput(
    history: HistoryItem[],
    newMessage: string,
  ): string {
    if (history.length === 0) {
      return newMessage;
    }
    // Build a conversation transcript the model can follow
    const transcript = history
      .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
      .join('\n\n');
    return `${transcript}\n\nUser: ${newMessage}`;
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
   * Process a single stream event, extracting text deltas.
   */
  private handleStreamEvent(
    event: RunStreamEvent,
    onDelta: (delta: string) => void,
  ): void {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    ) {
      const data = event.data;
      if ('delta' in data && typeof data.delta === 'string') {
        onDelta(data.delta);
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
