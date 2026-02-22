import { spawn } from 'node:child_process';
import type { JobRecord } from '../job-manager.js';

export type CodeRabbitPayload = {
  repoPath: string;
  baseRef: string;
  target: 'committed' | 'uncommitted';
  promptOnly: boolean;
};

export type CodeRabbitResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string;
};

function run(cmd: string, args: string[], cwd: string, onCancel: (fn: () => void) => void) {
  return new Promise<CodeRabbitResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });

    let stdout = '';
    let stderr = '';

    onCancel(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    });

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode, command: [cmd, ...args].join(' ') });
    });
  });
}

export async function coderabbitReview(job: JobRecord<CodeRabbitPayload, CodeRabbitResult>) {
  const { repoPath, baseRef, target, promptOnly } = job.payload;

  const cmd = `${process.env.HOME}/.local/bin/coderabbit`;
  const args = ['review'];
  if (promptOnly) args.push('--prompt-only');
  args.push('-t', target);
  args.push('--base', baseRef);

  let cancelFn: (() => void) | undefined;
  job.cancel = () => cancelFn?.();

  return await run(cmd, args, repoPath, (fn) => (cancelFn = fn));
}
