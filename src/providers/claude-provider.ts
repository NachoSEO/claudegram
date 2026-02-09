import {
  sendToAgent as claudeSendToAgent,
  sendLoopToAgent as claudeSendLoopToAgent,
  clearConversation as claudeClearConversation,
  setModel as claudeSetModel,
  getModel as claudeGetModel,
  clearModel as claudeClearModel,
  getCachedUsage as claudeGetCachedUsage,
  isDangerousMode as claudeIsDangerousMode,
} from '../claude/agent.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', label: 'opus', description: 'Most capable (default)' },
  { id: 'sonnet', label: 'sonnet', description: 'Balanced' },
  { id: 'haiku', label: 'haiku', description: 'Fast & light' },
];

export const claudeProvider: Provider = {
  name: 'claude',

  sendToAgent(chatId: number, message: string, options?: AgentOptions): Promise<AgentResponse> {
    return claudeSendToAgent(chatId, message, options);
  },

  sendLoopToAgent(chatId: number, message: string, options?: LoopOptions): Promise<AgentResponse> {
    return claudeSendLoopToAgent(chatId, message, options);
  },

  clearConversation(chatId: number): void {
    claudeClearConversation(chatId);
  },

  setModel(chatId: number, model: string): void {
    claudeSetModel(chatId, model);
  },

  getModel(chatId: number): string {
    return claudeGetModel(chatId);
  },

  clearModel(chatId: number): void {
    claudeClearModel(chatId);
  },

  getCachedUsage(chatId: number): AgentUsage | undefined {
    return claudeGetCachedUsage(chatId);
  },

  isDangerousMode(): boolean {
    return claudeIsDangerousMode();
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS;
  },
};
