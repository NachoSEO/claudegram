/**
 * Model catalog — provider-aware model lists for /model command.
 *
 * Returns the right set of models based on AGENT_PROVIDER config.
 */

import { config } from '../config.js';

interface ModelInfo {
  id: string;
  label: string;
  description: string;
}

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', label: 'Opus', description: 'Most capable model' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced speed and capability' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest model' },
];

const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'Flagship — best for coding & agentic tasks' },
  { id: 'gpt-5.2-pro', label: 'GPT-5.2 Pro', description: 'Maximum capability (expensive)' },
  { id: 'gpt-5.1', label: 'GPT-5.1', description: 'Previous flagship' },
  { id: 'gpt-5', label: 'GPT-5', description: 'Standard' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', description: 'Fast & cost-efficient' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano', description: 'Fastest, cheapest' },
  { id: 'gpt-5.3-codex-high', label: 'GPT-5.3 Codex High', description: 'Best agentic coding (highest quality)' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Best agentic coding model' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Agentic coding' },
  { id: 'gpt-4.1', label: 'GPT-4.1', description: '1M context window' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', description: '1M context, cost-efficient' },
];

export function getAvailableModels(): ModelInfo[] {
  return config.AGENT_PROVIDER === 'openai' ? OPENAI_MODELS : CLAUDE_MODELS;
}

export function getValidModelIds(): Set<string> {
  return new Set(getAvailableModels().map(m => m.id));
}

export function isValidModel(modelId: string): boolean {
  return getValidModelIds().has(modelId);
}

export type { ModelInfo };
