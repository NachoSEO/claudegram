export type ProviderName = 'claude' | 'opencode';

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
  /** Telegram context passed through for MCP tools (Claude provider only) */
  telegramCtx?: unknown;
}

export interface LoopOptions extends AgentOptions {
  maxIterations?: number;
  onIterationComplete?: (iteration: number, response: string) => void;
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

export interface Provider {
  readonly name: ProviderName;
  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse>;
  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse>;
  clearConversation(sessionKey: string): void;
  setModel(chatId: number, model: string): void;
  getModel(chatId: number): string;
  clearModel(chatId: number): void;
  getCachedUsage(sessionKey: string): AgentUsage | undefined;
  isDangerousMode(): boolean;
  getAvailableModels(chatId: number): Promise<ModelInfo[]>;
}
