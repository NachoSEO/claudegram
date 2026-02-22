import { spawn } from 'node:child_process';
import type { JobRecord } from '../job-manager.js';

export type NpmBuildPayload = {
  repoPath: string;
};

export type NpmBuildResult = {
  steps: Array<{ name: string; command: string; exitCode: number | null; stdout: string; stderr: string }>;
};

function runStep(cmd: string, args: string[], cwd: string, onCancel: (fn: () => void) => void) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });

    let stdout = '';
    let stderr = '';

    onCancel(() => {
      try { child.kill('SIGTERM'); } catch {}
    });

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr, command: [cmd, ...args].join(' ') }));
  });
}

export async function npmBuild(job: JobRecord<NpmBuildPayload, NpmBuildResult>) {
  const { repoPath } = job.payload;
  const steps: NpmBuildResult['steps'] = [];

  let cancelFn: (() => void) | undefined;
  job.cancel = () => cancelFn?.();

  const onCancel = (fn: () => void) => (cancelFn = fn);

  const typecheck = await runStep('npm', ['run', 'typecheck'], repoPath, onCancel);
  steps.push({ name: 'typecheck', ...typecheck });
  if (typecheck.exitCode !== 0) return { steps };

  const build = await runStep('npm', ['run', 'build'], repoPath, onCancel);
  steps.push({ name: 'build', ...build });

  return { steps };
}
