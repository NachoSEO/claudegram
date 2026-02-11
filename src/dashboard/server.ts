import { createServer, type Server } from 'http';
import { attachWebSocket } from './ws-server.js';
import { handleApiRequest, agentStatuses } from './api.js';
import { eventBus } from './event-bus.js';

let server: Server | null = null;

export function startDashboardServer(port: number = 3001): Server {
  server = createServer(async (req, res) => {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ status: 'ok', service: 'claudegram-dashboard' }));
    }
  });

  attachWebSocket(server);
  wireAgentStatusTracking();

  server.listen(port, () => {
    console.log(`[Dashboard] Server running on http://localhost:${port}`);
    console.log(`[Dashboard] WebSocket at ws://localhost:${port}/ws`);
  });

  return server;
}

export function stopDashboardServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}

// ── Keep agent status map updated from events ────────────────────────

function wireAgentStatusTracking(): void {
  eventBus.on('agent:start', (ev) => {
    const info = agentStatuses.get('claude')!;
    info.status = 'thinking';
    info.model = ev.model;
    info.currentActivity = ev.prompt.slice(0, 80);
    info.lastActivity = ev.timestamp;
  });

  eventBus.on('agent:complete', (ev) => {
    const info = agentStatuses.get('claude')!;
    info.status = 'ready';
    info.currentActivity = undefined;
    info.lastActivity = ev.timestamp;
  });

  eventBus.on('agent:error', (ev) => {
    const info = agentStatuses.get('claude')!;
    info.status = 'error';
    info.currentActivity = ev.error.slice(0, 80);
    info.lastActivity = ev.timestamp;
  });

  eventBus.on('voice:open', (ev) => {
    const info = agentStatuses.get('gemini')!;
    info.status = 'ready';
    info.lastActivity = ev.timestamp;
  });

  eventBus.on('voice:close', () => {
    const info = agentStatuses.get('gemini')!;
    info.status = 'offline';
  });

  eventBus.on('voice:text', (ev) => {
    const info = agentStatuses.get('gemini')!;
    info.currentActivity = ev.text.slice(0, 80);
    info.lastActivity = ev.timestamp;
  });

  eventBus.on('droid:start', (ev) => {
    const info = agentStatuses.get('droid')!;
    info.status = 'thinking';
    info.model = ev.model;
    info.currentActivity = ev.prompt.slice(0, 80);
    info.lastActivity = ev.timestamp;
  });

  eventBus.on('droid:complete', (ev) => {
    const info = agentStatuses.get('droid')!;
    info.status = ev.isError ? 'error' : 'ready';
    info.currentActivity = undefined;
    info.lastActivity = ev.timestamp;
  });
}
