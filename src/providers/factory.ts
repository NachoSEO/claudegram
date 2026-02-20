/**
 * Provider factory — returns the configured AgentProvider singleton.
 *
 * Reads `config.AGENT_PROVIDER` to decide between Claude and OpenAI.
 * Both providers are imported eagerly (tree-shaking irrelevant for a bot).
 */

import type { AgentProvider } from './types.js';
import { config } from '../config.js';
import { ClaudeProvider } from './claude-provider.js';
import { OpenAIProvider } from './openai-provider.js';

let provider: AgentProvider | undefined;

export function getProvider(): AgentProvider {
  if (provider) return provider;

  if (config.AGENT_PROVIDER === 'openai') {
    provider = new OpenAIProvider();
  } else {
    provider = new ClaudeProvider();
  }

  console.log(`[Provider] Initialized: ${config.AGENT_PROVIDER}`);
  return provider;
}
