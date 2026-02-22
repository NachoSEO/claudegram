export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JobRecord<TPayload = unknown, TResult = unknown> = {
  id: string;
  name: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  payload: TPayload;
  result?: TResult;
  error?: string;
  cancel?: () => void;
};

type JobRunner<TPayload, TResult> = (job: JobRecord<TPayload, TResult>) => Promise<TResult>;

export class JobManager {
  private jobs = new Map<string, JobRecord<any, any>>();
  private queue: Array<JobRecord<any, any>> = [];
  private running = 0;

  constructor(private readonly concurrency = 1) {}

  create<TPayload, TResult>(name: string, payload: TPayload, runner: JobRunner<TPayload, TResult>) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const job: JobRecord<TPayload, TResult> = {
      id,
      name,
      state: 'queued',
      createdAt: Date.now(),
      payload,
    };

    (job as any).__runner = runner;

    this.jobs.set(id, job);
    this.queue.push(job);
    void this.pump();
    return job;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.state === 'queued') {
      job.state = 'cancelled';
      this.queue = this.queue.filter((j) => j.id !== id);
      return true;
    }

    if (job.state === 'running') {
      job.state = 'cancelled';
      try {
        job.cancel?.();
      } catch {}
      return true;
    }

    return false;
  }

  private async pump() {
    while (this.running < this.concurrency) {
      const next = this.queue.shift();
      if (!next) return;
      if (next.state !== 'queued') continue;

      this.running++;
      next.state = 'running';
      next.startedAt = Date.now();

      const runner: JobRunner<any, any> = (next as any).__runner;

      Promise.resolve()
        .then(() => runner(next))
        .then((res) => {
          if (next.state === 'cancelled') return;
          next.state = 'succeeded';
          next.result = res;
        })
        .catch((err) => {
          if (next.state === 'cancelled') return;
          next.state = 'failed';
          next.error = err?.stack || err?.message || String(err);
        })
        .finally(() => {
          next.finishedAt = Date.now();
          this.running--;
          void this.pump();
        });
    }
  }
}
