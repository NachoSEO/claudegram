import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { sessionManager } from '../claude/session-manager.js';
import { getCachedUsage } from '../claude/agent.js';
import { isProcessing, getQueuePosition } from '../claude/request-queue.js';
import { config } from '../config.js';
import type { DashboardTask, AgentStatusInfo, QueueInfo } from './types.js';

// ── In-memory agent status (updated by eventBus listeners in server.ts) ──

export const agentStatuses: Map<string, AgentStatusInfo> = new Map([
  ['claude', { id: 'claude', status: 'ready', model: 'opus' }],
  ['gemini', { id: 'gemini', status: 'offline' }],
  ['droid', { id: 'droid', status: 'offline' }],
  ['groq', { id: 'groq', status: 'ready' }],
]);

// ── Task storage ────────────────────────────────────────────────────

const TASKS_DIR = join(homedir(), '.claudegram');
const TASKS_FILE = join(TASKS_DIR, 'dashboard-tasks.json');

function loadTasks(): DashboardTask[] {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks: DashboardTask[]): void {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ── Request helpers ─────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: 'Not found' }, 404);
}

// ── Route handler ───────────────────────────────────────────────────

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  // Only handle /api/* routes
  if (!path.startsWith('/api/')) return false;

  // GET /api/sessions
  if (path === '/api/sessions' && method === 'GET') {
    // sessionManager doesn't expose all sessions directly, but we can return
    // what's available through session history
    const sessions: Record<string, unknown>[] = [];
    // Return empty for now — the eventBus session events give real-time data
    json(res, { sessions });
    return true;
  }

  // GET /api/agents/status
  if (path === '/api/agents/status' && method === 'GET') {
    json(res, { agents: [...agentStatuses.values()] });
    return true;
  }

  // GET /api/queue
  if (path === '/api/queue' && method === 'GET') {
    const queues: QueueInfo[] = [];
    // We can't iterate all chatIds, but we track active ones via events
    json(res, { queues });
    return true;
  }

  // GET /api/usage/:chatId
  const usageMatch = path.match(/^\/api\/usage\/(-?\d+)$/);
  if (usageMatch && method === 'GET') {
    const chatId = parseInt(usageMatch[1], 10);
    const usage = getCachedUsage(chatId);
    json(res, { chatId, usage: usage || null });
    return true;
  }

  // GET /api/config
  if (path === '/api/config' && method === 'GET') {
    // Return safe config values (no API keys)
    json(res, {
      botName: config.BOT_NAME,
      botMode: config.BOT_MODE,
      streamingMode: config.STREAMING_MODE,
      dangerousMode: config.DANGEROUS_MODE,
      maxLoopIterations: config.MAX_LOOP_ITERATIONS,
      ttsProvider: config.TTS_PROVIDER,
      ttsVoice: config.TTS_VOICE,
    });
    return true;
  }

  // GET /api/voice/sessions
  if (path === '/api/voice/sessions' && method === 'GET') {
    // Voice sessions tracked via eventBus events
    json(res, { sessions: [] });
    return true;
  }

  // POST /api/tasks
  if (path === '/api/tasks' && method === 'POST') {
    const body = await parseBody(req) as Partial<DashboardTask>;
    const tasks = loadTasks();
    const task: DashboardTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: body.title || 'Untitled',
      description: body.description || '',
      status: body.status || 'todo',
      assignedAgent: body.assignedAgent,
      priority: body.priority || 'medium',
      linkedSession: body.linkedSession,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tasks.push(task);
    saveTasks(tasks);
    json(res, task, 201);
    return true;
  }

  // GET /api/tasks
  if (path === '/api/tasks' && method === 'GET') {
    json(res, { tasks: loadTasks() });
    return true;
  }

  // PUT /api/tasks/:id
  const taskMatch = path.match(/^\/api\/tasks\/(task_\w+)$/);
  if (taskMatch && method === 'PUT') {
    const taskId = taskMatch[1];
    const body = await parseBody(req) as Partial<DashboardTask>;
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) { notFound(res); return true; }
    tasks[idx] = { ...tasks[idx], ...body, id: taskId, updatedAt: Date.now() };
    saveTasks(tasks);
    json(res, tasks[idx]);
    return true;
  }

  // DELETE /api/tasks/:id
  if (taskMatch && method === 'DELETE') {
    const taskId = taskMatch[1];
    const tasks = loadTasks();
    const filtered = tasks.filter(t => t.id !== taskId);
    saveTasks(filtered);
    json(res, { deleted: taskId });
    return true;
  }

  notFound(res);
  return true;
}
