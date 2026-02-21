/**
 * MCP server lifecycle management for the OpenAI Agents SDK.
 *
 * Spawns and manages ShieldCortex (memory MCP server) as a stdio subprocess.
 * The OpenAI Agents SDK natively supports MCP via the Agent's `mcpServers`
 * property — tools from connected servers are automatically available to the model.
 *
 * Lifecycle:
 *   1. `connect()` — spawns the MCP server process and performs handshake
 *   2. Agent uses tools via `mcpServers` on each `run()` call
 *   3. `close()` — shuts down the server process
 */

import { MCPServerStdio } from '@openai/agents';
import type { MCPServer } from '@openai/agents';

import { config } from '../config.js';

/** Default ShieldCortex command — uses the local build. */
const DEFAULT_MCP_COMMAND = 'node';
const DEFAULT_MCP_ARGS = ['/home/player3vsgpt/ShieldCortex/dist/index.js', 'start'];

/**
 * Singleton MCP server manager.
 * Maintains a single ShieldCortex instance shared across all chats.
 */
class MCPManager {
  private server: MCPServerStdio | null = null;
  private connecting: Promise<void> | null = null;
  private connected = false;

  /**
   * Get the connected MCP servers array for the Agent constructor.
   * Returns empty array if MCP is not configured or connection failed.
   */
  async getServers(): Promise<MCPServer[]> {
    if (!this.connected && !this.connecting) {
      await this.connect();
    }
    if (this.connecting) {
      await this.connecting;
    }
    return this.server && this.connected ? [this.server] : [];
  }

  /**
   * Connect to ShieldCortex MCP server.
   * Safe to call multiple times — only connects once.
   */
  private async connect(): Promise<void> {
    if (this.connected || this.connecting) return;

    const command = config.MCP_MEMORY_COMMAND || DEFAULT_MCP_COMMAND;
    const args = config.MCP_MEMORY_ARGS
      ? config.MCP_MEMORY_ARGS.split(' ')
      : DEFAULT_MCP_ARGS;

    console.log(`[MCP] Connecting to ShieldCortex: ${command} ${args.join(' ')}`);

    this.connecting = (async () => {
      try {
        this.server = new MCPServerStdio({
          command,
          args,
          name: 'shieldcortex',
          cacheToolsList: true,
        });

        await this.server.connect();
        this.connected = true;

        // List tools to verify connection
        const tools = await this.server.listTools();
        const toolNames = tools.map((t) => t.name);
        console.log(`[MCP] ShieldCortex connected — ${tools.length} tools: ${toolNames.join(', ')}`);
      } catch (err) {
        console.error('[MCP] Failed to connect to ShieldCortex:', err instanceof Error ? err.message : err);
        this.server = null;
        this.connected = false;
      } finally {
        this.connecting = null;
      }
    })();

    await this.connecting;
  }

  /**
   * Shut down the MCP server. Called on process exit or full reset.
   */
  async close(): Promise<void> {
    if (this.server) {
      try {
        await this.server.close();
        console.log('[MCP] ShieldCortex disconnected');
      } catch (err) {
        console.error('[MCP] Error closing ShieldCortex:', err instanceof Error ? err.message : err);
      }
      this.server = null;
      this.connected = false;
      this.connecting = null;
    }
  }

  /** Check if ShieldCortex is connected. */
  isConnected(): boolean {
    return this.connected;
  }
}

/** Singleton instance. */
export const mcpManager = new MCPManager();
