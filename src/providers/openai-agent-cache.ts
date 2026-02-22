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


import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { config } from '../config.js';
import { getSystemPrompt } from './system-prompt.js';
import { createFsuiteTools } from './openai-tools.js';
import type { Platform } from './types.js';

const HISTORY_DIR = path.join(os.homedir(), '.claudegram');
const OPENAI_HISTORY_FILE = path.join(HISTORY_DIR, 'openai-history.json');

interface PersistedHistoryData {
  // chatId -> conversationId -> history items
  chats: Record<string, Record<string, HistoryItem[]>>;
}

function safeReadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as T;
    return parsed ?? fallback;
  } catch (err) {
    console.warn(`[AgentCache] Failed to read ${filePath}, starting fresh:`, err);
    return fallback;
  }
}

function safeWriteJsonFile(filePath: string, data: unknown): void {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[AgentCache] Failed to write ${filePath}:`, err);
  }
}

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
  conversationId?: string;
}

export class AgentCache {
  private readonly cache = new Map<number, ChatAgentState>();
  private persisted: PersistedHistoryData = safeReadJsonFile<PersistedHistoryData>(OPENAI_HISTORY_FILE, { chats: {} });

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
    conversationId?: string,
  ): ChatAgentState {
    const existing = this.cache.get(chatId);

    if (
      existing &&
      existing.model === model &&
      existing.cwd === cwd &&
      (conversationId ? existing.conversationId === conversationId : true)
    ) {
      return existing;
    }

    // Create fresh Agent with fsuite tools scoped to cwd + MCP servers
    const tools = createFsuiteTools(cwd, dangerousMode);
    const agent = new Agent({
      name: 'claudegram-openai',
      instructions: getSystemPrompt(platform, 'openai'),
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
      conversationId,
    };

    // If we have a conversationId (session restored), attempt to rehydrate history
    // from persisted storage so /continue and /resume actually restore context
    // after bot restart.
    if (conversationId) {
      const byChat = this.persisted.chats[String(chatId)] || {};
      const saved = byChat[conversationId];
      if (Array.isArray(saved) && saved.length > 0) {
        state.history = saved;
      }
    }

    this.cache.set(chatId, state);
    return state;
  }

  /** Persist a chat's conversation history keyed by conversationId. */
  saveHistory(chatId: number, conversationId: string | undefined, history: HistoryItem[]): void {
    if (!conversationId) return;
    const chatKey = String(chatId);
    if (!this.persisted.chats[chatKey]) this.persisted.chats[chatKey] = {};
    this.persisted.chats[chatKey][conversationId] = history;
    safeWriteJsonFile(OPENAI_HISTORY_FILE, this.persisted);
  }

  /** Remove a specific persisted conversation history (used by /clear). */
  deletePersistedHistory(chatId: number, conversationId: string | undefined): void {
    if (!conversationId) return;
    const chatKey = String(chatId);
    const byChat = this.persisted.chats[chatKey];
    if (!byChat) return;
    delete byChat[conversationId];
    if (Object.keys(byChat).length === 0) {
      delete this.persisted.chats[chatKey];
    }
    safeWriteJsonFile(OPENAI_HISTORY_FILE, this.persisted);
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
