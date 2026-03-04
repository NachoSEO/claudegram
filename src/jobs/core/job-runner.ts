import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { JobEvent, JobHandler, JobOrigin, JobRunContext } from './job-types';
import { JobRegistry } from './job-registry';

type EnqueueOpts = {
  name: string;
  origin: JobOrigin;
  handler: JobHandler;
  timeoutMs?: number;
};

type Running = {
  jobId: string;
  abort: AbortController;
  timeout?: NodeJS.Timeout;
};

export class JobRunner {
  private registry: JobRegistry;
  private emitter = new EventEmitter();
  private queue: Array<EnqueueOpts & { jobId: string; createdAt: number }> = [];
  private running: Running | null = null;
  private concurrency: number;

  constructor(registry: JobRegistry, concurrency = 1) {
    this.registry = registry;
    this.concurrency = Math.max(1, concurrency);
    if (this.concurrency !== 1) {
      // this version is intentionally single-worker; keep config for later
      this.concurrency = 1;
    }
  }

  onEvent(fn: (ev: JobEvent) => void) {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  enqueue(opts: EnqueueOpts): string {
    const jobId = crypto.randomUUID();
    const at = Date.now();

    this.registry.apply({ type: 'job:queued', jobId, name: opts.name, at });
    this.registry.setOrigin(jobId, opts.origin);
    this.emit({ type: 'job:queued', jobId, name: opts.name, at });

    this.queue.push({ ...opts, jobId, createdAt: at });
    void this.pump();
    return jobId;
  }

  get(jobId: string) {
    return this.registry.get(jobId);
  }

  listRecent(limit = 10) {
    return this.registry.listRecent(limit);
  }

  isRunning(jobId: string): boolean {
    return this.running?.jobId === jobId;
  }

  queueDepth(): number {
    return this.queue.length;
  }

  runningJobId(): string | null {
    return this.running?.jobId ?? null;
  }

  cancel(jobId: string): boolean {
    // cancel queued
    const idx = this.queue.findIndex((q) => q.jobId === jobId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      const at = Date.now();
      this.registry.apply({ type: 'job:end', jobId, state: 'canceled', at });
      this.emit({ type: 'job:end', jobId, state: 'canceled', at });
      return true;
    }

    // cancel running
    if (this.running?.jobId === jobId) {
      this.running.abort.abort();
      return true;
    }

    return false;
  }

  private emit(ev: JobEvent) {
    this.emitter.emit('event', ev);
  }

  private async pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;

    const jobId = next.jobId;
    const abort = new AbortController();
    const atStart = Date.now();

    this.running = { jobId, abort };
    this.registry.apply({ type: 'job:start', jobId, at: atStart });
    this.emit({ type: 'job:start', jobId, at: atStart });

    let timedOut = false;
    if (next.timeoutMs && next.timeoutMs > 0) {
      const t = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, next.timeoutMs);
      this.running.timeout = t;
    }

    const ctx: JobRunContext = {
      jobId,
      signal: abort.signal,
      progress: (message) => {
        const at = Date.now();
        this.registry.apply({ type: 'job:progress', jobId, message, at });
        this.emit({ type: 'job:progress', jobId, message, at });
      },
      log: (level, message) => {
        const at = Date.now();
        this.registry.apply({ type: 'job:log', jobId, level, message, at });
        this.emit({ type: 'job:log', jobId, level, message, at });
      },
    };

    try {
      const res = await next.handler(ctx);
      const exitCode = res && 'exitCode' in res ? res.exitCode : 0;
      const atEnd = Date.now();
      this.registry.apply({ type: 'job:end', jobId, state: 'succeeded', exitCode, at: atEnd });
      this.emit({ type: 'job:end', jobId, state: 'succeeded', exitCode, at: atEnd });
    } catch (err: any) {
      const atEnd = Date.now();
      const isAbort = abort.signal.aborted;
      const state = timedOut ? 'timeout' : isAbort ? 'canceled' : 'failed';
      const msg = err?.stack || err?.message || String(err);
      this.registry.setError(jobId, msg);
      ctx.log('error', msg);
      this.registry.apply({ type: 'job:end', jobId, state, exitCode: null, at: atEnd });
      this.emit({ type: 'job:end', jobId, state, exitCode: null, at: atEnd });
    } finally {
      if (this.running?.timeout) clearTimeout(this.running.timeout);
      this.running = null;
      // next
      void this.pump();
    }
  }
}
