import { config } from '../config.js';
import { claudeProvider } from './claude-provider.js';
import { userPreferences } from './user-preferences.js';
import type { Provider, ProviderName, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Re-export types for consumers
export type { AgentUsage, AgentResponse, AgentOptions, LoopOptions, ModelInfo, ProviderName };

// Per-chat provider selection (in-memory cache)
const chatProviders = new Map<number, ProviderName>();

// Load persisted preferences on startup
function loadPersistedProvider(chatId: number): ProviderName | undefined {
  return userPreferences.getProvider(chatId);
}

function savePersistedProvider(chatId: number, provider: ProviderName): void {
  userPreferences.setProvider(chatId, provider);
}

// Lazy-loaded opencode provider (only when needed)
let opencodeProvider: Provider | undefined;

async function getOpenCodeProvider(): Promise<Provider> {
  if (!opencodeProvider) {
    const mod = await import('./opencode-provider.js');
    opencodeProvider = mod.opencodeProvider;
  }
  return opencodeProvider;
}

function getProvider(chatId: number): Provider {
  const name = getActiveProviderName(chatId);
  if (name === 'opencode') {
    // If opencode hasn't been loaded yet, this is a sync access path.
    // The provider should already be loaded by the time we route messages,
    // because setActiveProvider (async) loads it first.
    if (!opencodeProvider) {
      throw new Error('OpenCode provider not initialized. Use /provider to switch first.');
    }
    return opencodeProvider;
  }
  return claudeProvider;
}

// --- Public API (identical signatures to agent.ts) ---

export function getActiveProviderName(chatId: number): ProviderName {
  if (!config.OPENCODE_ENABLED) return 'claude';
  // Check in-memory cache first
  const cached = chatProviders.get(chatId);
  if (cached) return cached;
  // Load from persistence
  const persisted = loadPersistedProvider(chatId);
  if (persisted) {
    chatProviders.set(chatId, persisted);
    return persisted;
  }
  return 'claude';
}

export async function setActiveProvider(chatId: number, provider: ProviderName): Promise<void> {
  if (provider === 'opencode') {
    await getOpenCodeProvider(); // ensure loaded
  }
  chatProviders.set(chatId, provider);
  savePersistedProvider(chatId, provider);
}

export function getAvailableProviders(): ProviderName[] {
  if (!config.OPENCODE_ENABLED) return ['claude'];
  return ['claude', 'opencode'];
}

export async function sendToAgent(
  chatId: number,
  message: string,
  options?: AgentOptions
): Promise<AgentResponse> {
  return getProvider(chatId).sendToAgent(chatId, message, options);
}

export async function sendLoopToAgent(
  chatId: number,
  message: string,
  options?: LoopOptions
): Promise<AgentResponse> {
  return getProvider(chatId).sendLoopToAgent(chatId, message, options);
}

export function clearConversation(chatId: number): void {
  // Clear both providers to avoid stale state
  claudeProvider.clearConversation(chatId);
  if (opencodeProvider) {
    opencodeProvider.clearConversation(chatId);
  }
}

export function setModel(chatId: number, model: string): void {
  // Store in user preferences directly (bypasses provider routing)
  userPreferences.setModel(chatId, model);
}

export function getModel(chatId: number): string {
  // Get from user preferences directly (bypasses provider routing)
  const persistedModel = userPreferences.getModel(chatId);
  if (persistedModel) return persistedModel;
  
  // Return default based on current provider
  const providerName = getActiveProviderName(chatId);
  if (providerName === 'opencode') {
    return 'anthropic/claude-sonnet-4-20250514';
  }
  return 'opus';
}

export function clearModel(chatId: number): void {
  // Clear from user preferences directly
  userPreferences.clearModel(chatId);
}

export function getCachedUsage(chatId: number): AgentUsage | undefined {
  return getProvider(chatId).getCachedUsage(chatId);
}

export function isDangerousMode(): boolean {
  // Dangerous mode is a Claude-specific concept; always check Claude provider
  return claudeProvider.isDangerousMode();
}

export async function getAvailableModels(chatId: number): Promise<ModelInfo[]> {
  const providerName = getActiveProviderName(chatId);
  if (providerName === 'opencode') {
    // Ensure opencode provider is loaded before accessing
    const provider = await getOpenCodeProvider();
    return provider.getAvailableModels(chatId);
  }
  return claudeProvider.getAvailableModels(chatId);
}
