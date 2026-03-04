/**
 * MCP server lifecycle management for the OpenAI Agents SDK.
 *
 * Manages multiple MCP servers (ShieldCortex memory, Playwright browser, etc.)
 * as stdio subprocesses. The OpenAI Agents SDK natively supports MCP via the
 * Agent's `mcpServers` property — tools from connected servers are automatically
 * available to the model.
 *
 * Lifecycle:
 *   1. `connectAll()` — spawns all configured MCP server processes
 *   2. Agent uses tools via `mcpServers` on each `run()` call
 *   3. `closeAll()` — shuts down all server processes
 */

import { MCPServerStdio } from '@openai/agents';
import type { MCPServer } from '@openai/agents';

import { config } from '../config.js';

/** MCP server definition — command + args to spawn via stdio. */
interface MCPServerDef {
  name: string;
  command: string;
  args: string[];
  /** Extra env vars passed to the child process. */
  env?: Record<string, string>;
  /** If set, only connect when this env var / config is truthy. */
  enabled: boolean;
}

/**
 * Parse args from config: supports JSON array (preferred) or space-separated string.
 * JSON array: '["start", "--flag"]' → ["start", "--flag"]
 * Fallback: 'start --flag' → ["start", "--flag"]
 */
function parseArgs(raw: string, fallback: string[]): string[] {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as string[];
    } catch {
      console.warn(`[MCP] Failed to parse args as JSON array: ${trimmed}`);
    }
  }
  return trimmed.split(/\s+/);
}

/**
 * Build the list of MCP servers to connect based on config.
 * ShieldCortex is always enabled; others are opt-in via env vars.
 */
function getServerDefinitions(): MCPServerDef[] {
  const servers: MCPServerDef[] = [];

  // ShieldCortex (memory) — always enabled
  // Pass CLAUDE_MEMORY_PROJECT so the subprocess uses the same project scope
  // as Claude Code (which auto-detects from its own CWD, typically the home dir).
  const memoryEnv: Record<string, string> = {};
  if (config.MCP_MEMORY_PROJECT) {
    memoryEnv.CLAUDE_MEMORY_PROJECT = config.MCP_MEMORY_PROJECT;
  }
  servers.push({
    name: 'shieldcortex',
    command: config.MCP_MEMORY_COMMAND || 'node',
    args: parseArgs(config.MCP_MEMORY_ARGS, ['/home/player3vsgpt/ShieldCortex/dist/index.js', 'start']),
    env: Object.keys(memoryEnv).length > 0 ? memoryEnv : undefined,
    enabled: true,
  });

  // Playwright (browser) — opt-in via MCP_PLAYWRIGHT_ENABLED
  if (config.MCP_PLAYWRIGHT_ENABLED) {
    servers.push({
      name: 'playwright',
      command: config.MCP_PLAYWRIGHT_COMMAND || 'npx',
      args: parseArgs(config.MCP_PLAYWRIGHT_ARGS, ['-y', '@playwright/mcp@latest', '--headless']),
      enabled: true,
    });
  }

  // Context7 (documentation/research MCP) — opt-in via MCP_CONTEXT7_ENABLED
  if (config.MCP_CONTEXT7_ENABLED) {
    servers.push({
      name: 'context7',
      command: config.MCP_CONTEXT7_COMMAND || 'npx',
      args: parseArgs(config.MCP_CONTEXT7_ARGS, ['-y', '@upstash/context7-mcp']),
      enabled: true,
    });
  }

  return servers;
}

/**
 * Multi-server MCP manager.
 * Maintains connected MCP server instances shared across all chats.
 */
class MCPManager {
  private servers: MCPServerStdio[] = [];
  private connecting: Promise<void> | null = null;
  private connected = false;

  /**
   * Get all connected MCP servers for the Agent constructor.
   * Returns empty array if no servers configured or all failed.
   */
  async getServers(): Promise<MCPServer[]> {
    if (!this.connected && !this.connecting) {
      await this.connectAll();
    }
    if (this.connecting) {
      await this.connecting;
    }
    return this.connected ? [...this.servers] : [];
  }

  /**
   * Connect all configured MCP servers.
   * Safe to call multiple times — only connects once.
   * Individual server failures don't block others.
   */
  private async connectAll(): Promise<void> {
    if (this.connected || this.connecting) return;

    this.connecting = (async () => {
      const defs = getServerDefinitions();
      const connected: MCPServerStdio[] = [];

      for (const def of defs) {
        if (!def.enabled) continue;

        const envInfo = def.env ? ` env=${JSON.stringify(def.env)}` : '';
        console.log(`[MCP] Connecting to ${def.name}: ${def.command} ${def.args.join(' ')}${envInfo}`);
        try {
          const server = new MCPServerStdio({
            command: def.command,
            args: def.args,
            name: def.name,
            cacheToolsList: true,
            ...(def.env ? { env: Object.fromEntries(
              Object.entries({ ...process.env, ...def.env }).filter((kv): kv is [string, string] => kv[1] != null),
            ) } : {}),
          });

          await server.connect();

          // List tools to verify connection
          const tools = await server.listTools();
          const toolNames = tools.map((t) => t.name);
          console.log(`[MCP] ${def.name} connected — ${tools.length} tools: ${toolNames.join(', ')}`);

          connected.push(server);
        } catch (err) {
          console.error(`[MCP] Failed to connect to ${def.name}:`, err instanceof Error ? err.message : err);
          // Continue — don't block other servers
        }
      }

      this.servers = connected;
      this.connected = true;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Shut down all MCP servers. Called on process exit or full reset.
   */
  async closeAll(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.close();
        console.log(`[MCP] ${server.name} disconnected`);
      } catch (err) {
        console.error(`[MCP] Error closing ${server.name}:`, err instanceof Error ? err.message : err);
      }
    }
    this.servers = [];
    this.connected = false;
    this.connecting = null;
  }

  /** Check if any MCP servers are connected. */
  isConnected(): boolean {
    return this.connected && this.servers.length > 0;
  }

  /** Get list of connected server names. */
  getConnectedNames(): string[] {
    return this.servers.map((s) => s.name);
  }
}

/** Singleton instance. */
export const mcpManager = new MCPManager();
