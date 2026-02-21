/**
 * Per-chat Agent lifecycle cache for the OpenAI Agents SDK.
 *
 * Each chat gets its own Agent instance. The cache invalidates when the model
 * or working directory changes, creating a fresh Agent with updated config.
 *
 * Multi-turn context is maintained via local message history (input list),
 * NOT via OpenAIConversationsSession or previousResponseId — the Codex
 * backend supports neither.
 */

import { Agent } from '@openai/agents';
import type { MCPServer } from '@openai/agents';

import { config } from '../config.js';
import { getSystemPrompt } from './system-prompt.js';
import { createFsuiteTools } from './openai-tools.js';
import type { Platform } from './types.js';

/** A single item in the conversation history (Responses API input format). */
export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAgentState {
  agent: Agent;
  model: string;
  cwd: string;
  /** Local conversation history for multi-turn context. */
  history: HistoryItem[];
  turnCount: number;
}

export class AgentCache {
  private readonly cache = new Map<number, ChatAgentState>();

  /**
   * Returns an existing Agent for the chat, or creates a new one.
   * Invalidates if model or cwd changed since last creation.
   */
  getOrCreate(
    chatId: number,
    model: string,
    cwd: string,
    platform: Platform = 'telegram',
    dangerousMode: boolean = config.DANGEROUS_MODE,
    mcpServers: MCPServer[] = [],
  ): ChatAgentState {
    const existing = this.cache.get(chatId);

    if (existing && existing.model === model && existing.cwd === cwd) {
      return existing;
    }

    // Create fresh Agent with fsuite tools scoped to cwd + MCP servers
    const tools = createFsuiteTools(cwd, dangerousMode);
    const agent = new Agent({
      name: 'claudegram-openai',
      instructions: getSystemPrompt(platform),
      model,
      tools,
      mcpServers,
    });

    const state: ChatAgentState = {
      agent,
      model,
      cwd,
      history: [],
      turnCount: 0,
    };

    this.cache.set(chatId, state);
    return state;
  }

  /** Increment and return the new turn count. */
  incrementTurn(chatId: number): number {
    const state = this.cache.get(chatId);
    if (!state) {
      console.warn(`[AgentCache] incrementTurn called for unknown chat ${chatId}`);
      return 1;
    }
    state.turnCount += 1;
    return state.turnCount;
  }

  /** Get the current turn count for a chat. */
  getTurnCount(chatId: number): number {
    return this.cache.get(chatId)?.turnCount ?? 0;
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
