/**
 * Provider abstraction layer — shared types for all AI providers.
 *
 * Both Claude and OpenAI providers implement `AgentProvider`.
 * Consumer code (agent.ts facade) programs against this interface.
 */

export type Platform = 'telegram' | 'discord';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  contextWindow: number;
  numTurns: number;
  model: string;
}

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
  usage?: AgentUsage;
  compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
  sessionInit?: { model: string; sessionId: string };
}

export interface AgentOptions {
  onProgress?: (text: string) => void;
  onToolStart?: (toolName: string, input?: Record<string, unknown>) => void;
  onToolEnd?: () => void;
  abortController?: AbortController;
  command?: string;
  model?: string;
  platform?: Platform;
}

export interface LoopOptions extends AgentOptions {
  maxIterations?: number;
  onIterationComplete?: (iteration: number, response: string) => void;
}

/** Minimal interface for cancelling an in-flight provider request. */
export interface Cancellable {
  interrupt(): Promise<void>;
}

export interface AgentProvider {
  send(
    chatId: number,
    message: string,
    options: AgentOptions,
  ): Promise<AgentResponse>;

  clearConversation(chatId: number): void;
  setModel(chatId: number, model: string): void;
  getModel(chatId: number): string;
  clearModel(chatId: number): void;
  getCachedUsage(chatId: number): AgentUsage | undefined;
  isDangerousMode(): boolean;
}
