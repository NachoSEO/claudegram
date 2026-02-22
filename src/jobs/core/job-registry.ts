import fs from 'node:fs';
import path from 'node:path';
import { JobEvent, JobSnapshot, JobState, JobLogLevel } from './job-types';

type RegistryOpts = {
  persistPath: string;
  ttlMs: number;
  maxLogsPerJob: number;
};

export class JobRegistry {
  private opts: RegistryOpts;
  private jobs = new Map<string, JobSnapshot>();

  constructor(opts: RegistryOpts) {
    this.opts = opts;
    fs.mkdirSync(path.dirname(opts.persistPath), { recursive: true });
  }

  get(jobId: string): JobSnapshot | undefined {
    return this.jobs.get(jobId);
  }

  listRecent(limit = 10): JobSnapshot[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, limit);
  }

  apply(ev: JobEvent) {
    const now = ev.at;
    const existing = this.jobs.get(ev.jobId);

    if (!existing) {
      if (ev.type !== 'job:queued') throw new Error(`unknown job ${ev.jobId}`);
      const snap: JobSnapshot = {
        jobId: ev.jobId,
        name: ev.name,
        createdAt: now,
        state: 'queued',
        origin: (null as any),
        logs: [],
      };
      this.jobs.set(ev.jobId, snap);
      this.persist(ev);
      this.sweep();
      return;
    }

    switch (ev.type) {
      case 'job:start':
        existing.state = 'running';
        existing.startedAt = now;
        break;
      case 'job:progress':
        existing.progress = ev.message;
        break;
      case 'job:log':
        existing.logs.push({ at: now, level: ev.level, message: ev.message });
        if (existing.logs.length > this.opts.maxLogsPerJob) {
          existing.logs.splice(0, existing.logs.length - this.opts.maxLogsPerJob);
        }
        break;
      case 'job:end':
        existing.state = ev.state as JobState;
        existing.endedAt = now;
        existing.exitCode = ev.exitCode;
        break;
      case 'job:queued':
        // ignore
        break;
    }

    this.persist(ev);
    this.sweep();
  }

  setOrigin(jobId: string, origin: JobSnapshot['origin']) {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`unknown job ${jobId}`);
    j.origin = origin;
  }

  setError(jobId: string, error: string) {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.error = error;
  }

  bootstrapFromDisk() {
    if (!fs.existsSync(this.opts.persistPath)) return;
    const raw = fs.readFileSync(this.opts.persistPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);

    // rebuild by replay
    this.jobs.clear();
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as JobEvent;
        if (ev.type === 'job:queued') {
          const snap: JobSnapshot = {
            jobId: ev.jobId,
            name: ev.name,
            createdAt: ev.at,
            state: 'queued',
            origin: (null as any),
            logs: [],
          };
          this.jobs.set(ev.jobId, snap);
        } else {
          const ex = this.jobs.get(ev.jobId);
          if (!ex) continue;
          this.apply(ev);
        }
      } catch {
        // ignore malformed line
      }
    }

    this.sweep();
  }

  markOrphansAsFailed(reason: string) {
    const now = Date.now();
    for (const j of this.jobs.values()) {
      if (j.state === 'running' || j.state === 'queued') {
        j.state = 'failed';
        j.endedAt = now;
        j.error = reason;
        j.logs.push({ at: now, level: 'error', message: reason });
      }
    }
  }

  private persist(ev: JobEvent) {
    fs.appendFileSync(this.opts.persistPath, JSON.stringify(ev) + '\n', 'utf8');
  }

  private sweep() {
    const cutoff = Date.now() - this.opts.ttlMs;
    for (const [id, j] of this.jobs) {
      const t = j.endedAt ?? j.createdAt;
      if (t < cutoff) this.jobs.delete(id);
    }
  }
}

export function defaultJobRegistry(repoRoot: string) {
  const persistPath = path.join(repoRoot, '.claudegram', 'jobs', 'jobs.jsonl');
  return new JobRegistry({ persistPath, ttlMs: 1000 * 60 * 60 * 24, maxLogsPerJob: 2000 });
}
