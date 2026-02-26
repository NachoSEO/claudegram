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

// Eagerly load the OpenCode module at startup when enabled, so that
// getProvider() never throws for users whose persisted preference is 'opencode'.
if (config.OPENCODE_ENABLED) {
  getOpenCodeProvider().catch((err) => {
    console.error('[ProviderRouter] Failed to pre-load OpenCode provider:', err);
  });
}

function getProvider(chatId: number): Provider {
  const name = getActiveProviderName(chatId);
  if (name === 'opencode') {
    if (!opencodeProvider) {
      // Fallback: if eager load hasn't completed yet, return Claude temporarily
      console.warn('[ProviderRouter] OpenCode provider not ready yet, falling back to Claude');
      return claudeProvider;
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
  sessionKey: string,
  message: string,
  options?: AgentOptions
): Promise<AgentResponse> {
  const chatId = Number(sessionKey.split(':')[0]);
  return getProvider(chatId).sendToAgent(sessionKey, message, options);
}

export async function sendLoopToAgent(
  sessionKey: string,
  message: string,
  options?: LoopOptions
): Promise<AgentResponse> {
  const chatId = Number(sessionKey.split(':')[0]);
  return getProvider(chatId).sendLoopToAgent(sessionKey, message, options);
}

export function clearConversation(sessionKey: string): void {
  // Clear both providers to avoid stale state
  claudeProvider.clearConversation(sessionKey);
  if (opencodeProvider) {
    opencodeProvider.clearConversation(sessionKey);
  }
}

export function setModel(chatId: number, model: string): void {
  getProvider(chatId).setModel(chatId, model);
}

export function getModel(chatId: number): string {
  return getProvider(chatId).getModel(chatId);
}

export function clearModel(chatId: number): void {
  getProvider(chatId).clearModel(chatId);
}

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  const chatId = Number(sessionKey.split(':')[0]);
  return getProvider(chatId).getCachedUsage(sessionKey);
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
