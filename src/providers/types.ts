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
  sendToAgent(chatId: number, message: string, options?: AgentOptions): Promise<AgentResponse>;
  sendLoopToAgent(chatId: number, message: string, options?: LoopOptions): Promise<AgentResponse>;
  clearConversation(chatId: number): void;
  setModel(chatId: number, model: string): void;
  getModel(chatId: number): string;
  clearModel(chatId: number): void;
  getCachedUsage(chatId: number): AgentUsage | undefined;
  isDangerousMode(): boolean;
  getAvailableModels(chatId: number): Promise<ModelInfo[]>;
}
