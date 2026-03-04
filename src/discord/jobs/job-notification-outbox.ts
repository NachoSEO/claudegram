import fs from 'node:fs';
import path from 'node:path';
import type { JobSnapshot, JobState } from '../../jobs/core/job-types.js';

type NonRunningState = Exclude<JobState, 'queued' | 'running'>;

type OutboxStatus = 'pending' | 'sent' | 'failed';

export type OutboxItem = {
  key: string;
  channelId: string;
  threadId?: string;
  guildId?: string;
  userId?: string;
  statusMessageId?: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  jobs: Array<{
    jobId: string;
    name: string;
    state: NonRunningState;
    endedAt: number;
    error?: string;
  }>;
  critical: boolean;
  createdAt: number;
};

function outboxKey(s: JobSnapshot): string {
  return [
    s.origin.guildId ?? 'dm',
    s.origin.channelId,
    s.origin.threadId ?? 'no-thread',
    s.origin.userId ?? 'any-user',
  ].join(':');
}

function toJobDigest(s: JobSnapshot) {
  return {
    jobId: s.jobId,
    name: s.name,
    state: s.state as NonRunningState,
    endedAt: s.endedAt ?? Date.now(),
    error: s.error,
  };
}

export class JobNotificationOutbox {
  private pendingByKey = new Map<string, OutboxItem>();
  private persistPath: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? path.join(process.cwd(), '.claudegram', 'jobs', 'outbox.json');
    this.bootstrapFromDisk();
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    const data = JSON.stringify(Array.from(this.pendingByKey.values()), null, 2);
    const tmp = `${this.persistPath}.tmp`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, this.persistPath);
  }

  private bootstrapFromDisk() {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        if (!it || typeof it.key !== 'string' || typeof it.channelId !== 'string') continue;
        this.pendingByKey.set(it.key, it as OutboxItem);
      }
    } catch {
      // ignore malformed persisted outbox
    }
  }

  enqueueFromSnapshot(s: JobSnapshot): OutboxItem | null {
    if (s.state === 'queued' || s.state === 'running') return null;
    if (!s.origin?.channelId) return null;

    const key = outboxKey(s);
    const critical = s.state === 'failed' || s.state === 'timeout';
    const digest = toJobDigest(s);
    const existing = this.pendingByKey.get(key);

    if (!existing) {
      const item: OutboxItem = {
        key,
        channelId: s.origin.channelId,
        threadId: s.origin.threadId,
        guildId: s.origin.guildId,
        userId: s.origin.userId,
        statusMessageId: s.origin.statusMessageId,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
        jobs: [digest],
        critical,
        createdAt: Date.now(),
      };
      this.pendingByKey.set(key, item);
      this.persist();
      return item;
    }

    // Deduplicate by jobId and append latest terminal record
    existing.jobs = existing.jobs.filter((j) => j.jobId !== digest.jobId);
    existing.jobs.push(digest);
    existing.critical = existing.critical || critical;
    this.persist();
    return existing;
  }

  markAttemptFailure(key: string, error: string) {
    const item = this.pendingByKey.get(key);
    if (!item) return;
    item.attempts += 1;
    const backoffMs = Math.min(60_000, 2_000 * Math.pow(2, Math.max(0, item.attempts - 1)));
    item.nextAttemptAt = Date.now() + backoffMs;
    item.lastError = error.slice(0, 240);
    item.status = item.attempts >= 8 ? 'failed' : 'pending';
    this.persist();
  }

  markAttemptSuccess(key: string) {
    this.markSent(key);
  }

  getFailed(): OutboxItem[] {
    return Array.from(this.pendingByKey.values()).filter((i) => i.status === 'failed');
  }

  getPending(now = Date.now()): OutboxItem[] {
    return Array.from(this.pendingByKey.values()).filter((i) => i.status === 'pending' && i.nextAttemptAt <= now);
  }

  markSent(key: string) {
    const item = this.pendingByKey.get(key);
    if (!item) return;
    item.status = 'sent';
    this.pendingByKey.delete(key);
    this.persist();
  }
}

export const jobNotificationOutbox = new JobNotificationOutbox();
