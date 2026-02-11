import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { eventBus } from './event-bus.js';
import type { DashboardEventType, WsMessage } from './types.js';

const ALL_EVENTS: DashboardEventType[] = [
  'agent:start', 'agent:progress', 'agent:tool_start', 'agent:tool_end', 'agent:complete', 'agent:error',
  'voice:open', 'voice:close', 'voice:text', 'voice:tool_call', 'voice:interrupted',
  'droid:start', 'droid:stream', 'droid:complete',
  'session:create', 'session:update', 'session:clear',
  'queue:enqueue', 'queue:dequeue', 'queue:processing',
];

let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[Dashboard WS] Client connected');

    ws.on('close', () => {
      console.log('[Dashboard WS] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[Dashboard WS] Client error:', err.message);
    });
  });

  // Subscribe to all eventBus events and fan out to connected clients
  for (const eventType of ALL_EVENTS) {
    eventBus.on(eventType, (payload) => {
      broadcast({ type: eventType, payload } as WsMessage);
    });
  }

  console.log('[Dashboard WS] WebSocket server attached');
  return wss;
}

function broadcast(message: WsMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
