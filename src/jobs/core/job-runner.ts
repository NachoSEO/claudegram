import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { JobEvent, JobHandler, JobLane, JobOrigin, JobRunContext } from './job-types';
import { JobRegistry } from './job-registry';

type EnqueueOpts = {
  name: string;
  lane?: JobLane;
  origin: JobOrigin;
  handler: JobHandler;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  idempotencyKey?: string;
  parentJobId?: string;
  rootJobId?: string;
};

type RetrySpec = {
  name: string;
  lane: JobLane;
  origin: JobOrigin;
  handler: JobHandler;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  parentJobId?: string;
  rootJobId?: string;
};

type Running = {
  jobId: string;
  lane: JobLane;
  abort: AbortController;
  timeout?: NodeJS.Timeout;
  stallWatchdog?: NodeJS.Timeout;
  lastActivityAt: number;
  startedAt: number;
};

type JobMetricsSnapshot = {
  totalQueued: number;
  totalStarted: number;
  totalEnded: number;
  totalSucceeded: number;
  totalFailed: number;
  totalCanceled: number;
  totalTimeout: number;
  queueDepth: number;
  running: boolean;
  peakQueueDepth: number;
  waitP95Ms: number;
  runP95Ms: number;
};

export class JobRunner {
  private registry: JobRegistry;
  private emitter = new EventEmitter();
  private queues = new Map<JobLane, Array<EnqueueOpts & { lane: JobLane; jobId: string; createdAt: number }>>();
  private running: Running | null = null;
  private concurrency: number;
  private retrySpecs = new Map<string, RetrySpec>();
  private metrics = {
    totalQueued: 0,
    totalStarted: 0,
    totalEnded: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalCanceled: 0,
    totalTimeout: 0,
    peakQueueDepth: 0,
    waitSamples: [] as number[],
    runSamples: [] as number[],
  };

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

  private normalizeLane(lane?: JobLane): JobLane {
    return lane ?? 'main';
  }

  private laneQueue(lane: JobLane) {
    let q = this.queues.get(lane);
    if (!q) {
      q = [];
      this.queues.set(lane, q);
    }
    return q;
  }

  private totalQueueDepth() {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  private nextLane(): JobLane | null {
    const preferred: JobLane[] = ['main', 'review', 'subagent', 'maintenance'];
    for (const lane of preferred) {
      if ((this.queues.get(lane)?.length ?? 0) > 0) return lane;
    }
    for (const [lane, queue] of this.queues) {
      if (queue.length > 0) return lane;
    }
    return null;
  }

  enqueue(opts: EnqueueOpts): string {
    const jobId = crypto.randomUUID();
    const at = Date.now();
    const lane = this.normalizeLane(opts.lane);

    if (opts.idempotencyKey) {
      const reserved = this.registry.reserveIdempotency(opts.idempotencyKey, jobId);
      if (!reserved.ok) return reserved.existingJobId;
    }

      const rootJobId = opts.rootJobId ?? opts.parentJobId ?? jobId;
    this.registry.apply({ type: 'job:queued', jobId, name: opts.name, lane, at, parentJobId: opts.parentJobId, rootJobId });
    this.registry.setOrigin(jobId, opts.origin);
    if (opts.idempotencyKey) {
      this.registry.apply({ type: 'job:idempotency', jobId, key: opts.idempotencyKey, at });
    }
    this.emit({ type: 'job:queued', jobId, name: opts.name, lane, at, parentJobId: opts.parentJobId, rootJobId });

    this.laneQueue(lane).push({ ...opts, lane, rootJobId, jobId, createdAt: at });
    this.metrics.totalQueued += 1;
    const queueDepth = this.totalQueueDepth();
    if (queueDepth > this.metrics.peakQueueDepth) this.metrics.peakQueueDepth = queueDepth;
    this.retrySpecs.set(jobId, {
      name: opts.name,
      lane,
      origin: { ...opts.origin },
      handler: opts.handler,
        timeoutMs: opts.timeoutMs,
        stallTimeoutMs: opts.stallTimeoutMs,
      parentJobId: opts.parentJobId,
      rootJobId,
    });
    void this.pump();
    return jobId;
  }

  retry(jobId: string): string | null {
    const spec = this.retrySpecs.get(jobId);
    if (!spec) return null;
    return this.enqueue({
      name: spec.name,
      lane: spec.lane,
      origin: { ...spec.origin },
      handler: spec.handler,
        timeoutMs: spec.timeoutMs,
        stallTimeoutMs: spec.stallTimeoutMs,
      parentJobId: spec.parentJobId,
      rootJobId: spec.rootJobId,
    });
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
    return this.totalQueueDepth();
  }

  runningJobId(): string | null {
    return this.running?.jobId ?? null;
  }

  getMetrics(): JobMetricsSnapshot {
    return {
      totalQueued: this.metrics.totalQueued,
      totalStarted: this.metrics.totalStarted,
      totalEnded: this.metrics.totalEnded,
      totalSucceeded: this.metrics.totalSucceeded,
      totalFailed: this.metrics.totalFailed,
      totalCanceled: this.metrics.totalCanceled,
      totalTimeout: this.metrics.totalTimeout,
      queueDepth: this.totalQueueDepth(),
      running: Boolean(this.running),
      peakQueueDepth: this.metrics.peakQueueDepth,
      waitP95Ms: this.p95(this.metrics.waitSamples),
      runP95Ms: this.p95(this.metrics.runSamples),
    };
  }

  cancel(jobId: string): boolean {
    for (const queue of this.queues.values()) {
      const idx = queue.findIndex((q) => q.jobId === jobId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        const at = Date.now();
        this.registry.apply({ type: 'job:end', jobId, state: 'canceled', at });
        this.emit({ type: 'job:end', jobId, state: 'canceled', at });
        return true;
      }
    }

    if (this.running?.jobId === jobId) {
      this.running.abort.abort();
      return true;
    }

    return false;
  }

  private emit(ev: JobEvent) {
    this.emitter.emit('event', ev);
  }

  updateOrigin(jobId: string, origin: JobOrigin) {
    const at = Date.now();
    this.registry.apply({ type: 'job:origin', jobId, origin, at });
    this.emit({ type: 'job:origin', jobId, origin, at });
  }

  private async pump() {
    if (this.running) return;
    const lane = this.nextLane();
    if (!lane) return;
    const next = this.laneQueue(lane).shift();
    if (!next) return;

    const jobId = next.jobId;
    const abort = new AbortController();
    const atStart = Date.now();

    this.running = { jobId, lane, abort, lastActivityAt: atStart, startedAt: atStart };
    this.metrics.totalStarted += 1;
    this.pushSample(this.metrics.waitSamples, Math.max(0, atStart - next.createdAt));
    this.registry.apply({ type: 'job:start', jobId, lane, at: atStart });
    this.emit({ type: 'job:start', jobId, lane, at: atStart });

    let timedOut = false;
    let stalledOut = false;
    if (next.timeoutMs && next.timeoutMs > 0) {
      const t = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, next.timeoutMs);
      if (this.running) this.running.timeout = t;
    }

    const stallTimeoutMs =
      typeof next.stallTimeoutMs === 'number' && next.stallTimeoutMs > 0
        ? next.stallTimeoutMs
        : 1000 * 60 * 6;
    const watchdogTickMs = Math.min(30_000, Math.max(5_000, Math.floor(stallTimeoutMs / 6)));
    const watchdog = setInterval(() => {
      const current = this.running;
      if (!current || current.jobId !== jobId) return;
      const idleMs = Date.now() - current.lastActivityAt;
      if (idleMs >= stallTimeoutMs) {
        stalledOut = true;
        abort.abort();
      }
    }, watchdogTickMs);
    if (this.running) this.running.stallWatchdog = watchdog;

    const ctx: JobRunContext = {
      jobId,
      lane,
      parentJobId: next.parentJobId,
      rootJobId: next.rootJobId ?? next.parentJobId ?? jobId,
      origin: next.origin,
      signal: abort.signal,
      progress: (message) => {
        const at = Date.now();
        if (this.running?.jobId === jobId) this.running.lastActivityAt = at;
        this.registry.apply({ type: 'job:progress', jobId, message, at });
        this.emit({ type: 'job:progress', jobId, message, at });
      },
      log: (level, message) => {
        const at = Date.now();
        if (this.running?.jobId === jobId) this.running.lastActivityAt = at;
        this.registry.apply({ type: 'job:log', jobId, level, message, at });
        this.emit({ type: 'job:log', jobId, level, message, at });
      },
    };

    try {
      const res = await next.handler(ctx);
      const exitCode = res && 'exitCode' in res ? res.exitCode : 0;
      const atEnd = Date.now();
      if (res && ('resultSummary' in res || 'artifacts' in res)) {
        const summary = typeof res.resultSummary === 'string' ? res.resultSummary : undefined;
        const artifacts = Array.isArray(res.artifacts) ? res.artifacts : undefined;
        this.registry.apply({ type: 'job:result', jobId, summary, artifacts, at: atEnd });
        this.emit({ type: 'job:result', jobId, summary, artifacts, at: atEnd });
      }
      this.registry.apply({ type: 'job:end', jobId, state: 'succeeded', exitCode, at: atEnd });
      this.emit({ type: 'job:end', jobId, state: 'succeeded', exitCode, at: atEnd });
      this.metrics.totalEnded += 1;
      this.metrics.totalSucceeded += 1;
      this.pushSample(this.metrics.runSamples, Math.max(0, atEnd - atStart));
    } catch (err: any) {
      const atEnd = Date.now();
      const isAbort = abort.signal.aborted;
      const state = timedOut || stalledOut ? 'timeout' : isAbort ? 'canceled' : 'failed';
      const msg = err?.stack || err?.message || String(err);
      this.registry.setError(jobId, msg);
      ctx.log('error', msg);
      this.registry.apply({ type: 'job:end', jobId, state, exitCode: null, at: atEnd });
      this.emit({ type: 'job:end', jobId, state, exitCode: null, at: atEnd });
      this.metrics.totalEnded += 1;
      if (state === 'failed') this.metrics.totalFailed += 1;
      if (state === 'canceled') this.metrics.totalCanceled += 1;
      if (state === 'timeout') this.metrics.totalTimeout += 1;
      this.pushSample(this.metrics.runSamples, Math.max(0, atEnd - atStart));
    } finally {
      if (this.running?.timeout) clearTimeout(this.running.timeout);
      if (this.running?.stallWatchdog) clearInterval(this.running.stallWatchdog);
      this.running = null;
      void this.pump();
    }
  }

  private pushSample(arr: number[], value: number) {
    arr.push(value);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
  }

  private p95(arr: number[]): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
    return sorted[idx] ?? 0;
  }
}
