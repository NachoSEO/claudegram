/**
 * Per-chat Agent lifecycle cache for the OpenAI Agents SDK.
 *
 * Each chat gets its own Agent instance. The cache invalidates when the model
 * or working directory changes, creating a fresh Agent with updated config.
 * Uses OpenAIConversationsSession for server-side multi-turn persistence.
 */

import { Agent } from '@openai/agents';
import { OpenAIConversationsSession } from '@openai/agents-openai';

import { config } from '../config.js';
import { getSystemPrompt } from './system-prompt.js';
import { createFsuiteTools } from './openai-tools.js';
import type { Platform } from './types.js';

export interface ChatAgentState {
  agent: Agent;
  model: string;
  cwd: string;
  session: OpenAIConversationsSession;
  turnCount: number;
}

export class AgentCache {
  private readonly cache = new Map<number, ChatAgentState>();

  /**
   * Returns an existing Agent for the chat, or creates a new one.
   * Invalidates if model or cwd changed since last creation.
   *
   * @param openaiConversationId - Existing conversation ID to resume (from session persistence)
   */
  getOrCreate(
    chatId: number,
    model: string,
    cwd: string,
    platform: Platform = 'telegram',
    openaiConversationId?: string,
  ): ChatAgentState {
    const existing = this.cache.get(chatId);

    if (existing && existing.model === model && existing.cwd === cwd) {
      return existing;
    }

    // Clean up old session server-side if being replaced (best-effort)
    if (existing?.session) {
      existing.session.clearSession().catch(() => {});
    }

    // Create fresh Agent with fsuite tools scoped to cwd
    const tools = createFsuiteTools(cwd, config.DANGEROUS_MODE);
    const agent = new Agent({
      name: 'claudegram-openai',
      instructions: getSystemPrompt(platform),
      model,
      tools,
    });

    // Resume existing conversation or start fresh
    const session = new OpenAIConversationsSession(
      openaiConversationId ? { conversationId: openaiConversationId } : undefined,
    );

    const state: ChatAgentState = {
      agent,
      model,
      cwd,
      session,
      turnCount: 0,
    };

    this.cache.set(chatId, state);
    return state;
  }

  /** Replace the session with a fresh one (used for stale session recovery). */
  resetSession(chatId: number): void {
    const state = this.cache.get(chatId);
    if (state) {
      state.session = new OpenAIConversationsSession();
      state.turnCount = 0;
    }
  }

  /** Increment and return the new turn count. */
  incrementTurn(chatId: number): number {
    const state = this.cache.get(chatId);
    if (state) {
      state.turnCount += 1;
      return state.turnCount;
    }
    return 1;
  }

  /** Get the current turn count for a chat. */
  getTurnCount(chatId: number): number {
    return this.cache.get(chatId)?.turnCount ?? 0;
  }

  /** Get the session for a chat. */
  getSession(chatId: number): OpenAIConversationsSession | undefined {
    return this.cache.get(chatId)?.session;
  }

  /** Remove a chat's cached state entirely (used by /clear). */
  delete(chatId: number): void {
    this.cache.delete(chatId);
  }

  /** Get the Agent instance for a chat (used for hook matching). */
  getAgent(chatId: number): Agent | undefined {
    return this.cache.get(chatId)?.agent;
  }

  /** Check if a chat has a cached agent. */
  has(chatId: number): boolean {
    return this.cache.has(chatId);
  }
}
