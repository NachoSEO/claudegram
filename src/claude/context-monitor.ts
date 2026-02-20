import { Api } from 'grammy';
import { escapeMarkdownV2 } from '../telegram/markdown.js';
import { eventBus } from '../dashboard/event-bus.js';
import type { AgentCompleteEvent } from '../dashboard/types.js';

/**
 * Context Monitor — fires independent Telegram alerts when context window runs low.
 *
 * Listens to `agent:complete` events on the event bus and calculates the
 * remaining context percentage after every agent response. When the context
 * drops below configured thresholds (default: 15% and 5% remaining), it
 * sends a notification directly via the Telegram Bot API — completely
 * independent of the streaming pipeline. This means alerts fire even if the
 * agent is mid-tool-call or mid-stream.
 *
 * Each threshold fires only once per session (per chatId). Thresholds
 * reset on session clear.
 */

interface MonitorState {
  /** Set of thresholds (as percentages remaining) that have already fired */
  firedThresholds: Set<number>;
  /** Last known remaining % for logging */
  lastRemainingPct: number;
}

const THRESHOLDS = [15, 5]; // remaining % — alert when context drops below these

export class ContextMonitor {
  private api: Api | null = null;
  private states: Map<number, MonitorState> = new Map();
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /**
   * Initialize the monitor with the Grammy Bot API instance.
   * Must be called after bot.init() so we have a valid API handle.
   */
  start(api: Api): void {
    if (!this.enabled) return;

    this.api = api;
    eventBus.on('agent:complete', this.onAgentComplete);
    console.log('[ContextMonitor] Started — watching for low context thresholds');
  }

  /**
   * Stop listening and clean up.
   */
  stop(): void {
    eventBus.off('agent:complete', this.onAgentComplete);
    this.states.clear();
    this.api = null;
  }

  /**
   * Reset threshold tracking for a chat (call on /clear, /softreset, etc.)
   */
  resetChat(chatId: number): void {
    this.states.delete(chatId);
  }

  private onAgentComplete = (event: AgentCompleteEvent): void => {
    if (!this.api || !event.usage) return;

    const { chatId } = event;
    const { inputTokens, outputTokens, cacheReadTokens, contextWindow } = event.usage;

    if (contextWindow <= 0) return;

    // Active context = input + output (cache reads don't consume context window)
    const usedTokens = inputTokens + outputTokens;
    const remainingPct = Math.round(Math.max(0, Math.min(100, ((contextWindow - usedTokens) / contextWindow) * 100)));

    // Get or create state for this chat
    let state = this.states.get(chatId);
    if (!state) {
      state = { firedThresholds: new Set(), lastRemainingPct: 100 };
      this.states.set(chatId, state);
    }

    state.lastRemainingPct = remainingPct;

    // Check each threshold
    for (const threshold of THRESHOLDS) {
      if (remainingPct <= threshold && !state.firedThresholds.has(threshold)) {
        state.firedThresholds.add(threshold);
        this.sendAlert(chatId, remainingPct, threshold, event.usage).catch((err) => {
          console.error(`[ContextMonitor] Failed to send alert for chat ${chatId}:`, err);
        });
      }
    }
  };

  private async sendAlert(
    chatId: number,
    remainingPct: number,
    threshold: number,
    usage: NonNullable<AgentCompleteEvent['usage']>,
  ): Promise<void> {
    if (!this.api) return;

    const isCritical = threshold <= 5;
    const emoji = isCritical ? '🔴' : '🟡';
    const urgency = isCritical
      ? 'CRITICAL — context almost exhausted'
      : 'LOW CONTEXT WARNING';

    const usedTokens = usage.inputTokens + usage.outputTokens;
    const usedStr = this.formatTokens(usedTokens);
    const totalStr = this.formatTokens(usage.contextWindow);

    const esc = escapeMarkdownV2;
    const message = [
      `${emoji} *${esc(urgency)}*`,
      '',
      `Context remaining: *${esc(String(remainingPct))}%*`,
      `Tokens: ${esc(usedStr)} / ${esc(totalStr)}`,
      `Cost so far: \\$${esc(usage.totalCostUsd.toFixed(4))}`,
      `Turns: ${esc(String(usage.numTurns))}`,
      '',
      isCritical
        ? '_Wrap up now or use /handoff to save context before compaction\\._'
        : '_Consider wrapping up soon or using /handoff to preserve context\\._',
    ].join('\n');

    try {
      await this.api.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
      console.log(`[ContextMonitor] Alert sent: chat=${chatId} remaining=${remainingPct}% threshold=${threshold}%`);
    } catch (err) {
      // Fallback to plain text if Markdown fails
      const plainMessage = [
        `${emoji} ${urgency}`,
        '',
        `Context remaining: ${remainingPct}%`,
        `Tokens: ${usedStr} / ${totalStr}`,
        `Cost so far: $${usage.totalCostUsd.toFixed(4)}`,
        `Turns: ${usage.numTurns}`,
        '',
        isCritical
          ? 'Wrap up now or use /handoff to save context before compaction.'
          : 'Consider wrapping up soon or using /handoff to preserve context.',
      ].join('\n');

      await this.api.sendMessage(chatId, plainMessage).catch((fallbackErr) => {
        console.error(`[ContextMonitor] Fallback send also failed for chat ${chatId}:`, fallbackErr);
      });
    }
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }
}

/** Singleton instance — initialized in index.ts */
export const contextMonitor = new ContextMonitor();
