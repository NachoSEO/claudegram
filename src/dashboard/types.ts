// ── Dashboard shared types ───────────────────────────────────────────

// Agent identifiers
export type AgentId = 'claude' | 'gemini' | 'droid' | 'groq';
export type AgentStatus = 'ready' | 'thinking' | 'error' | 'offline';

// ── Event payloads ───────────────────────────────────────────────────

export interface AgentStartEvent {
  chatId: number;
  model: string;
  prompt: string;
  sessionId?: string;
  timestamp: number;
}

export interface AgentProgressEvent {
  chatId: number;
  text: string;
  timestamp: number;
}

export interface AgentToolStartEvent {
  chatId: number;
  toolName: string;
  input?: Record<string, unknown>;
  timestamp: number;
}

export interface AgentToolEndEvent {
  chatId: number;
  toolName: string;
  timestamp: number;
}

export interface AgentCompleteEvent {
  chatId: number;
  text: string;
  toolsUsed: string[];
  usage?: AgentUsageData;
  durationMs: number;
  timestamp: number;
}

export interface AgentErrorEvent {
  chatId: number;
  error: string;
  timestamp: number;
}

export interface AgentUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  contextWindow: number;
  numTurns: number;
  model: string;
}

// Voice events
export interface VoiceOpenEvent {
  guildId: string;
  channelId: string;
  timestamp: number;
}

export interface VoiceCloseEvent {
  guildId: string;
  reason: string;
  timestamp: number;
}

export interface VoiceTextEvent {
  guildId: string;
  text: string;
  timestamp: number;
}

export interface VoiceToolCallEvent {
  guildId: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface VoiceInterruptedEvent {
  guildId: string;
  timestamp: number;
}

// Droid events
export interface DroidStartEvent {
  prompt: string;
  model: string;
  timestamp: number;
}

export interface DroidStreamEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

export interface DroidCompleteEvent {
  result: string;
  durationMs: number;
  isError: boolean;
  timestamp: number;
}

// Session events
export interface SessionCreateEvent {
  chatId: number;
  conversationId: string;
  workingDirectory: string;
  timestamp: number;
}

export interface SessionUpdateEvent {
  chatId: number;
  conversationId: string;
  claudeSessionId?: string;
  timestamp: number;
}

export interface SessionClearEvent {
  chatId: number;
  timestamp: number;
}

// Queue events
export interface QueueEnqueueEvent {
  chatId: number;
  message: string;
  queueDepth: number;
  timestamp: number;
}

export interface QueueDequeueEvent {
  chatId: number;
  timestamp: number;
}

export interface QueueProcessingEvent {
  chatId: number;
  isProcessing: boolean;
  timestamp: number;
}

// ── Event map ────────────────────────────────────────────────────────

export interface DashboardEventMap {
  'agent:start': AgentStartEvent;
  'agent:progress': AgentProgressEvent;
  'agent:tool_start': AgentToolStartEvent;
  'agent:tool_end': AgentToolEndEvent;
  'agent:complete': AgentCompleteEvent;
  'agent:error': AgentErrorEvent;

  'voice:open': VoiceOpenEvent;
  'voice:close': VoiceCloseEvent;
  'voice:text': VoiceTextEvent;
  'voice:tool_call': VoiceToolCallEvent;
  'voice:interrupted': VoiceInterruptedEvent;

  'droid:start': DroidStartEvent;
  'droid:stream': DroidStreamEvent;
  'droid:complete': DroidCompleteEvent;

  'session:create': SessionCreateEvent;
  'session:update': SessionUpdateEvent;
  'session:clear': SessionClearEvent;

  'queue:enqueue': QueueEnqueueEvent;
  'queue:dequeue': QueueDequeueEvent;
  'queue:processing': QueueProcessingEvent;
}

export type DashboardEventType = keyof DashboardEventMap;

// ── WebSocket message envelope ───────────────────────────────────────

export interface WsMessage<T extends DashboardEventType = DashboardEventType> {
  type: T;
  payload: DashboardEventMap[T];
}

// ── REST API types ───────────────────────────────────────────────────

export interface AgentStatusInfo {
  id: AgentId;
  status: AgentStatus;
  model?: string;
  currentActivity?: string;
  lastActivity?: number;
}

export interface QueueInfo {
  chatId: number;
  depth: number;
  isProcessing: boolean;
}

export interface DashboardTask {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'archived';
  assignedAgent?: AgentId;
  priority: 'low' | 'medium' | 'high' | 'critical';
  linkedSession?: string;
  createdAt: number;
  updatedAt: number;
}
