import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { JobHandler } from '../core/job-types';

const execAsync = promisify(exec);

export type NpmBuildV2Payload = {
  repoPath: string;
};

export const npmBuildV2 = (payload: NpmBuildV2Payload): JobHandler => {
  return async (ctx) => {
    const run = async (name: string, command: string) => {
      ctx.progress(name);
      ctx.log('info', `Running: ${command}`);
      const { stdout, stderr } = await execAsync(command, {
        cwd: payload.repoPath,
        maxBuffer: 1024 * 1024 * 10,
        env: { ...process.env },
        signal: ctx.signal as any,
      });
      if (stdout) ctx.log('info', stdout.trim().slice(-12000));
      if (stderr) ctx.log('warn', stderr.trim().slice(-12000));
    };

    await run('typecheck', 'npm run typecheck');
    await run('build', 'npm run build');

    ctx.progress('done');
    return { exitCode: 0 };
  };
};
