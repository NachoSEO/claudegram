import { spawn } from 'child_process';
import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { userPreferences } from './user-preferences.js';
import { BoundedMap } from '../utils/bounded-map.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Lazy-loaded SDK types — only resolved when this provider is activated
type OpencodeClient = Awaited<ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>>;
type OpencodeServer = Awaited<ReturnType<typeof import('@opencode-ai/sdk').createOpencode>>;

// Per-chat state (in-memory cache)
// chatModels is intentionally unbounded — it's backed by persistent preferences
const chatModels = new Map<number, string>();
const chatSessionIds = new BoundedMap<number, string>(1000);
const chatUsageCache = new BoundedMap<number, AgentUsage>(1000);

// Load persisted model preference
function getPersistedModel(chatId: number): string | undefined {
  return userPreferences.getModel(chatId);
}

function setPersistedModel(chatId: number, model: string): void {
  userPreferences.setModel(chatId, model);
}

function clearPersistedModel(chatId: number): void {
  userPreferences.clearModel(chatId);
}

// Cached model list (refreshed on /model)
let cachedModels: ModelInfo[] | undefined;

async function fetchModels(): Promise<ModelInfo[]> {
  const c = await getClient();
  const result = await c.config.providers();

  if (result.error || !result.data) {
    throw new Error('Failed to fetch providers');
  }

  const providersData = result.data.providers as Array<{
    id?: string;
    name?: string;
    models?: Record<string, { name?: string; id?: string }>;
  }>;

  const models: ModelInfo[] = [];
  for (const provider of providersData) {
    const providerId = provider.id || 'unknown';
    if (!provider.models) continue;
    for (const [modelKey, modelConfig] of Object.entries(provider.models)) {
      const modelId = modelConfig.id || modelKey;
      models.push({
        id: `${providerId}/${modelId}`,
        label: modelConfig.name || modelId,
        description: provider.name || providerId,
      });
    }
  }

  cachedModels = models;
  return models;
}

// Singleton client + optional server handle
let client: OpencodeClient | undefined;
let server: OpencodeServer | undefined;

async function checkExistingServer(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://127.0.0.1:${port}/config/providers`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!response.ok) return false;

    // Verify the response looks like an OpenCode providers endpoint
    const body = await response.json() as Record<string, unknown>;
    return Array.isArray(body.providers);
  } catch {
    return false;
  }
}

async function spawnOpencodeServer(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['serve', '--port', String(port)];

    console.log(`[OpenCode] Spawning server: opencode ${args.join(' ')}`);

    const proc = spawn('opencode', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    let started = false;

    proc.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      // Check if server is ready
      if (line.includes('listening') || line.includes('ready')) {
        if (!started) {
          started = true;
          resolve(`http://localhost:${port}`);
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn opencode: ${err.message}`));
    });

    proc.on('exit', (code) => {
      if (code !== 0 && !started) {
        reject(new Error(`OpenCode server exited with code ${code}. stderr: ${stderr}`));
      }
    });

    // Timeout fallback - assume it started after 3 seconds
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(`http://localhost:${port}`);
      }
    }, 3000);
  });
}

async function getClient(): Promise<OpencodeClient> {
  if (client) return client;

  try {
    const sdk = await import('@opencode-ai/sdk');
    const opencodeConfig = config as Record<string, unknown>;
    let baseUrl = opencodeConfig.OPENCODE_BASE_URL as string | undefined;

    if (!baseUrl && process.platform === 'win32') {
      // On Windows, check for existing server first, then spawn if needed
      const port = validatePort(opencodeConfig.OPENCODE_PORT);
      const existingUrl = `http://localhost:${port}`;
      
      if (await checkExistingServer(port)) {
        baseUrl = existingUrl;
      } else {
        baseUrl = await spawnOpencodeServer(port);
      }
    }

    if (baseUrl) {
      // Connect to existing running server
      client = sdk.createOpencodeClient({ baseUrl });
      if (!client) {
        throw new Error('createOpencodeClient returned undefined');
      }
      console.log(`[OpenCode] Connected to server at ${baseUrl}`);
    } else {
      // Start embedded server (non-Windows)
      const port = validatePort(opencodeConfig.OPENCODE_PORT);
      const result = await sdk.createOpencode({ port });

      // Validate result structure
      if (!result) {
        throw new Error('createOpencode returned undefined');
      }

      // Handle different SDK return types
      if (typeof result === 'object' && 'client' in result) {
        client = result.client as OpencodeClient;
        server = result as OpencodeServer;
      } else {
        // SDK might return client directly
        client = result as unknown as OpencodeClient;
      }

      if (!client) {
        throw new Error('Failed to create OpenCode client from SDK result');
      }

      console.log(`[OpenCode] Started embedded server on port ${port}`);
    }

    // Eagerly populate the model list so getModelSpec/getModel have a default
    if (!cachedModels) {
      await fetchModels();
    }

    return client;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[OpenCode] Failed to initialize client: ${errorMsg}`);
    throw new Error(`OpenCode initialization failed: ${errorMsg}`);
  }
}

function validatePort(portValue: unknown): number {
  const defaultPort = 4096;

  if (portValue === undefined || portValue === null) {
    return defaultPort;
  }

  let port: number;
  if (typeof portValue === 'string') {
    port = parseInt(portValue, 10);
  } else if (typeof portValue === 'number') {
    port = portValue;
  } else {
    console.warn(`[OpenCode] Invalid port type, using default ${defaultPort}`);
    return defaultPort;
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.warn(`[OpenCode] Invalid port number ${port}, using default ${defaultPort}`);
    return defaultPort;
  }

  return port;
}

async function ensureSession(chatId: number): Promise<string> {
  const existing = chatSessionIds.get(chatId);
  if (existing) return existing;

  const c = await getClient();
  const result = await c.session.create({
    body: { title: `telegram-chat-${chatId}` },
  });

  if (result.error) {
    throw new Error(`Failed to create OpenCode session: ${JSON.stringify(result.error)}`);
  }

  const sessionId = result.data.id;
  chatSessionIds.set(chatId, sessionId);
  return sessionId;
}

function getModelSpec(chatId: number): { providerID: string; modelID: string } {
  // Check in-memory cache first, then persistence
  let model = chatModels.get(chatId);
  if (!model) {
    model = getPersistedModel(chatId);
    if (model) {
      chatModels.set(chatId, model);
    }
  }
  if (!model && cachedModels?.[0]) {
    model = cachedModels[0].id;
  }
  if (!model) {
    throw new Error('No model configured and no models available from OpenCode server');
  }
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    return { providerID: model.slice(0, slashIdx), modelID: model.slice(slashIdx + 1) };
  }
  // Fallback: treat as bare model ID with anthropic provider
  return { providerID: 'anthropic', modelID: model };
}

export const opencodeProvider: Provider = {
  name: 'opencode',

  async sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    const chatId = Number(sessionKey.split(':')[0]);
    const { onProgress, onToolStart, onToolEnd, abortController } = options || {};
    const c = await getClient();
    const sessionId = await ensureSession(chatId);
    const modelSpec = getModelSpec(chatId);

    const session = sessionManager.getSession(sessionKey);
    if (!session) {
      throw new Error('No active session. Use /project to set working directory.');
    }
    sessionManager.updateActivity(sessionKey, message);

    // Send prompt
    const promptResult = await c.session.prompt({
      path: { id: sessionId },
      body: {
        model: modelSpec,
        parts: [{ type: 'text', text: message }],
      },
    });
    if (promptResult.error) {
      throw new Error(`OpenCode prompt failed: ${JSON.stringify(promptResult.error)}`);
    }

    // Extract text from initial response (model may complete immediately)
    let fullText = '';
    const toolsUsed: string[] = [];

    if (promptResult.data?.parts) {
      const parts = promptResult.data.parts as Array<{ type: string; text?: string; tool?: string }>;
      for (const part of parts) {
        if (part.type === 'text' && part.text) {
          fullText += part.text;
        } else if (part.type === 'tool' && part.tool) {
          if (!toolsUsed.includes(part.tool)) toolsUsed.push(part.tool);
        }
      }
      if (fullText) {
        onProgress?.(fullText);
      }
    }

    // If response is complete, return immediately
    const responseInfo = promptResult.data?.info as { finish?: string } | undefined;
    if (responseInfo?.finish === 'stop' && fullText) {
      return {
        text: fullText,
        toolsUsed,
        usage: undefined, // Will be extracted below if needed
      };
    }

    // Set up abort handler
    if (abortController) {
      const onAbort = () => {
        c.session.abort({ path: { id: sessionId } }).catch((err: unknown) => {
          console.error('[OpenCode] Abort failed:', err);
        });
      };
      if (abortController.signal.aborted) {
        return { text: '🛑 Request cancelled.', toolsUsed: [] };
      }
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Stream events for async responses

    try {
      const events = await c.event.subscribe();

      // Runtime validation: the SDK returns an object with a .stream async iterable
      if (!events || typeof events !== 'object' || !('stream' in events)) {
        throw new Error('Unexpected event stream shape from OpenCode SDK');
      }

      type EventStream = AsyncIterable<{ type: string; properties: Record<string, unknown> }>;
      const stream = (events as { stream: EventStream }).stream;

      for await (const event of stream) {
        if (abortController?.signal.aborted) {
          fullText = fullText || '🛑 Request cancelled.';
          break;
        }

        if (event.type === 'message.part.updated') {
          const part = event.properties.part as { type: string; sessionID: string; text?: string; tool?: string; state?: { status: string } };
          if (part.sessionID !== sessionId) continue;

          if (part.type === 'text') {
            fullText = part.text || '';
            onProgress?.(fullText);
          } else if (part.type === 'tool') {
            const toolState = part.state as { status: string } | undefined;
            if (toolState?.status === 'running') {
              const toolName = part.tool || 'unknown';
              if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
              onToolStart?.(toolName);
            } else if (toolState?.status === 'completed') {
              onToolEnd?.();
            }
          }
        } else if (event.type === 'session.idle') {
          const idleSessionId = event.properties.sessionID as string;
          if (idleSessionId === sessionId) break;
        } else if (event.type === 'session.error') {
          const errorSessionId = (event.properties.info as { sessionID?: string })?.sessionID
            || event.properties.sessionID as string;
          if (errorSessionId === sessionId) {
            const errMsg = (event.properties as { error?: string }).error || 'Unknown OpenCode error';
            fullText = `❌ OpenCode error: ${errMsg}`;
            onProgress?.(fullText);
            break;
          }
        }
      }
    } catch (err) {
      console.error(`[OpenCode] Event stream error:`, err);
      if (abortController?.signal.aborted) {
        return { text: '✅ Successfully cancelled - no tools or agents in process.', toolsUsed };
      }
      throw err;
    }

    // Fetch final messages to extract usage
    let resultUsage: AgentUsage | undefined;
    try {
      const msgsResult = await c.session.messages({ path: { id: sessionId } });
      if (!msgsResult.error && msgsResult.data) {
        const msgArray = msgsResult.data as Array<{
          info: {
            role: string;
            tokens?: { input: number; output: number; cache?: { read: number; write: number } };
            cost?: number;
            modelID?: string;
          };
        }>;
        const assistants = msgArray.filter(m => m.info.role === 'assistant');
        const lastAssistant = assistants[assistants.length - 1]?.info;
        if (lastAssistant?.tokens) {
          resultUsage = {
            inputTokens: lastAssistant.tokens.input || 0,
            outputTokens: lastAssistant.tokens.output || 0,
            cacheReadTokens: lastAssistant.tokens.cache?.read || 0,
            cacheWriteTokens: lastAssistant.tokens.cache?.write || 0,
            totalCostUsd: lastAssistant.cost || 0,
            contextWindow: 200000,
            numTurns: assistants.length,
            model: lastAssistant.modelID || chatModels.get(chatId) || 'unknown',
          };
          chatUsageCache.set(chatId, resultUsage);
        }
      }
    } catch {
      // Usage extraction is best-effort
    }

    return {
      text: fullText || 'No response from OpenCode.',
      toolsUsed,
      usage: resultUsage,
    };
  },

  async sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    // OpenCode already runs full agentic loops, so delegate directly
    return opencodeProvider.sendToAgent(sessionKey, message, options);
  },

  clearConversation(sessionKey: string): void {
    const chatId = Number(sessionKey.split(':')[0]);
    chatSessionIds.delete(chatId);
    chatUsageCache.delete(chatId);
  },

  setModel(chatId: number, model: string): void {
    chatModels.set(chatId, model);
    setPersistedModel(chatId, model);
  },

  getModel(chatId: number): string {
    // Check in-memory cache first, then persistence
    let model = chatModels.get(chatId);
    if (!model) {
      model = getPersistedModel(chatId);
      if (model) {
        chatModels.set(chatId, model);
      }
    }
    return model || cachedModels?.[0]?.id || 'unknown';
  },

  clearModel(chatId: number): void {
    chatModels.delete(chatId);
    clearPersistedModel(chatId);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    const chatId = Number(sessionKey.split(':')[0]);
    return chatUsageCache.get(chatId);
  },

  isDangerousMode(): boolean {
    return false; // OpenCode manages its own permissions
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    try {
      return await fetchModels();
    } catch (err) {
      console.error('[OpenCode] Failed to fetch models:', err);
      if (cachedModels) return cachedModels;
      throw new Error('Failed to fetch available models from OpenCode server');
    }
  },
};
