export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout';

export type JobLogLevel = 'info' | 'warn' | 'error';

export type JobEvent =
  | { type: 'job:queued'; jobId: string; name: string; at: number }
  | { type: 'job:idempotency'; jobId: string; key: string; at: number }
  | { type: 'job:start'; jobId: string; at: number }
  | { type: 'job:progress'; jobId: string; message: string; at: number }
  | { type: 'job:log'; jobId: string; level: JobLogLevel; message: string; at: number }
  | { type: 'job:result'; jobId: string; summary?: string; artifacts?: string[]; at: number }
  | { type: 'job:end'; jobId: string; state: Exclude<JobState, 'queued' | 'running'>; exitCode?: number | null; at: number };

export type JobOrigin = {
  guildId?: string;
  channelId: string;
  threadId?: string;
  userId: string;
  // where the bot should edit/update
  statusMessageId?: string;
};

export type JobSnapshot = {
  jobId: string;
  name: string;
  createdAt: number;
  idempotencyKey?: string;
  startedAt?: number;
  endedAt?: number;
  state: JobState;
  origin: JobOrigin;
  progress?: string;
  exitCode?: number | null;
  error?: string;
  logs: Array<{ at: number; level: JobLogLevel; message: string }>;
  resultSummary?: string;
  artifacts?: string[];
};

export type JobRunContext = {
  jobId: string;
  signal: AbortSignal;
  progress: (message: string) => void;
  log: (level: JobLogLevel, message: string) => void;
};

export type JobHandler = (ctx: JobRunContext) => Promise<{
  exitCode?: number | null;
  resultSummary?: string;
  artifacts?: string[];
} | void>;
