/**
 * OpenAI Chat Completions provider.
 *
 * Phase 1: Chat-only via raw Chat Completions API.
 * Phase 2 (planned): Upgrade to @openai/agents SDK for full agentic capabilities
 * (shell, code interpreter, web search, file search, multi-agent handoffs).
 */

import OpenAI from 'openai';

import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { setActiveQuery, isCancelled } from '../claude/request-queue.js';
import { eventBus } from '../dashboard/event-bus.js';
import { contextMonitor } from '../claude/context-monitor.js';
import { getSystemPrompt, stripReasoningSummary } from './system-prompt.js';

import type {
  AgentProvider,
  AgentUsage,
  AgentResponse,
  AgentOptions,
  Cancellable,
} from './types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Context window sizes for OpenAI models (Feb 2026). */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // GPT-5.2 family — current flagship
  'gpt-5.2': 400_000,
  'gpt-5.2-pro': 400_000,
  // GPT-5.1 family
  'gpt-5.1': 400_000,
  'gpt-5.1-codex': 400_000,
  'gpt-5.1-codex-mini': 400_000,
  // GPT-5 family
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  // GPT-5.2/5.3 Codex (agentic coding)
  'gpt-5.2-codex': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
  // GPT-4.1 family (1M context)
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  // Legacy (still available in API)
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
const CONTEXT_TRUNCATION_RATIO = 0.8;
/** Rough estimate: 1 token ≈ 4 chars for truncation math. */
const CHARS_PER_TOKEN = 4;

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

export class OpenAIProvider implements AgentProvider {
  private client: OpenAI;
  private readonly chatHistories = new Map<number, ChatMessage[]>();
  private readonly chatModels = new Map<number, string>();
  private readonly chatUsageCache = new Map<number, AgentUsage>();
  private readonly chatTurnCounts = new Map<number, number>();

  constructor() {
    if (!config.OPENAI_API_KEY) {
      throw new Error('[OpenAI] OPENAI_API_KEY is required when AGENT_PROVIDER=openai');
    }
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    console.log(`[OpenAI] Provider initialized, default model: ${config.OPENAI_DEFAULT_MODEL}`);
  }

  async send(
    chatId: number,
    message: string,
    options: AgentOptions,
  ): Promise<AgentResponse> {
    const { onProgress, abortController, command, model, platform } = options;

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

    // Get or initialize history with system prompt
    let history = this.chatHistories.get(chatId);
    if (!history) {
      history = [{ role: 'system', content: getSystemPrompt(platform) }];
    }

    // Add user message
    history.push({ role: 'user', content: prompt });

    // Truncate if approaching context limit
    this.truncateHistory(history, contextWindow);

    const agentStartTime = Date.now();
    const controller = abortController || new AbortController();

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
      const runner = this.client.chat.completions.stream(
        {
          model: effectiveModel,
          messages: history,
          stream_options: { include_usage: true },
        },
        { signal: controller.signal },
      );

      runner.on('content', (diff) => {
        fullText += diff;
        onProgress?.(fullText);
      });

      runner.on('totalUsage', (usage) => {
        const turns = this.chatTurnCounts.get(chatId) ?? 0;
        resultUsage = {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCostUsd: 0, // OpenAI doesn't report cost in the response
          contextWindow,
          numTurns: turns + 1,
          model: effectiveModel,
        };
      });

      // Wait for stream to finish
      await runner.finalChatCompletion();

    } catch (error: unknown) {
      if (isCancelled(chatId) || controller.signal.aborted) {
        eventBus.emit('agent:complete', {
          chatId,
          text: '✅ Cancelled',
          toolsUsed: [],
          durationMs: Date.now() - agentStartTime,
          timestamp: Date.now(),
        });
        return {
          text: '✅ Successfully cancelled - no tools or agents in process.',
          toolsUsed: [],
        };
      }

      console.error('[OpenAI] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      eventBus.emit('agent:error', { chatId, error: errorMessage, timestamp: Date.now() });
      eventBus.emit('agent:complete', {
        chatId,
        text: '',
        toolsUsed: [],
        durationMs: Date.now() - agentStartTime,
        timestamp: Date.now(),
      });
      throw new Error(`OpenAI error: ${errorMessage}`);
    }

    // Store assistant response in history
    if (fullText && !controller.signal.aborted) {
      history.push({ role: 'assistant', content: fullText });
    }
    this.chatHistories.set(chatId, history);

    // Update turn count
    const turns = (this.chatTurnCounts.get(chatId) ?? 0) + 1;
    this.chatTurnCounts.set(chatId, turns);

    // Cache usage
    if (resultUsage) {
      this.chatUsageCache.set(chatId, resultUsage);
    }

    eventBus.emit('agent:complete', {
      chatId,
      text: fullText.slice(0, 500),
      toolsUsed: [],
      usage: resultUsage,
      durationMs: Date.now() - agentStartTime,
      timestamp: Date.now(),
    });

    return {
      text: stripReasoningSummary(fullText) || 'No response from OpenAI.',
      toolsUsed: [],
      usage: resultUsage,
    };
  }

  clearConversation(chatId: number): void {
    this.chatHistories.delete(chatId);
    this.chatUsageCache.delete(chatId);
    this.chatTurnCounts.delete(chatId);
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

  /**
   * Truncate oldest messages (preserving system prompt) when history
   * exceeds ~80% of the model's context window.
   */
  private truncateHistory(history: ChatMessage[], contextWindow: number): void {
    const maxChars = contextWindow * CHARS_PER_TOKEN * CONTEXT_TRUNCATION_RATIO;

    let totalChars = 0;
    for (const msg of history) {
      totalChars += msg.content.length;
    }

    if (totalChars <= maxChars) return;

    // Always keep the system prompt (index 0) and the latest user message (last)
    while (totalChars > maxChars && history.length > 2) {
      const removed = history.splice(1, 1)[0];
      totalChars -= removed.content.length;
    }

    console.log(`[OpenAI] Truncated history to ${history.length} messages (${Math.round(totalChars / 1000)}k chars)`);
  }
}
