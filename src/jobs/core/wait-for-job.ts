import { JobRunner } from './job-runner';

export async function waitForJob(runner: JobRunner, jobId: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (true) {
    const snap = runner.get(jobId);
    if (!snap) throw new Error(`unknown job ${jobId}`);
    if (snap.state !== 'queued' && snap.state !== 'running') return snap;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitForJob timeout (${timeoutMs}ms)`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
