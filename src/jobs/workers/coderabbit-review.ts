import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
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

type CodeRabbitStructuredResult = {
  verdict: 'clean' | 'issues' | 'failed';
  criticalIssues: string[];
  risks: string[];
  exactFixes: string[];
  summary: string;
  artifacts: string[];
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

async function resolveCodeRabbitBinary(): Promise<string> {
  const home = process.env.HOME;
  const candidates = [
    home ? `${home}/.local/bin/coderabbit` : null,
    'coderabbit',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c.includes('/')) {
      try {
        await access(c, FS.X_OK);
        return c;
      } catch {
        // continue
      }
    } else {
      // rely on PATH
      return c;
    }
  }

  throw new Error('CodeRabbit binary not found. Expected ~/.local/bin/coderabbit or coderabbit in PATH.');
}

function parseCodeRabbitOutput(raw: CodeRabbitResult): CodeRabbitStructuredResult {
  const combined = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
  const lines = `${raw.stdout}\n${raw.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const criticalIssues = lines.filter((l) => /(critical|blocker|security|severe)/i.test(l)).slice(0, 12);
  const risks = lines.filter((l) => /(risk|warning|warn|concern|unstable)/i.test(l)).slice(0, 12);
  const exactFixes = lines.filter((l) => /(fix|change|replace|refactor|should)/i.test(l)).slice(0, 20);

  const hasIssueSignal = /(fail|error|issue|warning|critical|risk)/i.test(combined);
  const verdict: CodeRabbitStructuredResult['verdict'] =
    raw.exitCode && raw.exitCode !== 0 ? 'failed' : hasIssueSignal ? 'issues' : 'clean';

  const summary =
    verdict === 'clean'
      ? 'CodeRabbit review completed with no major issues detected from CLI output.'
      : verdict === 'failed'
        ? 'CodeRabbit review command failed; inspect stderr and logs.'
        : `CodeRabbit reported potential issues (${criticalIssues.length} critical markers, ${risks.length} risk markers).`;

  return { verdict, criticalIssues, risks, exactFixes, summary, artifacts: [] };
}

async function writeReviewArtifacts(repoPath: string, jobId: string, raw: CodeRabbitResult, parsed: CodeRabbitStructuredResult) {
  const dir = path.join(repoPath, '.claudegram', 'artifacts', 'jobs', jobId);
  await mkdir(dir, { recursive: true });

  const resultPath = path.join(dir, 'result.json');
  const summaryPath = path.join(dir, 'summary.md');

  await writeFile(resultPath, JSON.stringify({ raw, parsed }, null, 2), 'utf8');
  await writeFile(
    summaryPath,
    [
      `# CodeRabbit Result (${jobId})`,
      `- Verdict: **${parsed.verdict}**`,
      `- Exit Code: ${raw.exitCode ?? 'null'}`,
      `- Summary: ${parsed.summary}`,
      '',
      '## Critical Issues',
      ...(parsed.criticalIssues.length ? parsed.criticalIssues.map((x) => `- ${x}`) : ['- none detected']),
      '',
      '## Risks',
      ...(parsed.risks.length ? parsed.risks.map((x) => `- ${x}`) : ['- none detected']),
      '',
      '## Exact Fixes',
      ...(parsed.exactFixes.length ? parsed.exactFixes.map((x) => `- ${x}`) : ['- none extracted']),
    ].join('\n'),
    'utf8',
  );

  return { resultPath, summaryPath };
}

export async function coderabbitReview(job: JobRecord<CodeRabbitPayload, CodeRabbitResult>) {
  const { repoPath, baseRef, target, promptOnly } = job.payload;

  const cmd = await resolveCodeRabbitBinary();
  const args = ['review'];
  if (promptOnly) args.push('--prompt-only');
  args.push('-t', target);
  args.push('--base', baseRef);

  let cancelFn: (() => void) | undefined;
  job.cancel = () => cancelFn?.();

  const raw = await run(cmd, args, repoPath, (fn) => (cancelFn = fn));
  const parsed = parseCodeRabbitOutput(raw);
  const artifacts = await writeReviewArtifacts(repoPath, job.id, raw, parsed);

  return {
    ...raw,
    resultSummary: parsed.summary,
    artifacts: [artifacts.resultPath, artifacts.summaryPath],
    verdict: parsed.verdict,
    counts: {
      critical: parsed.criticalIssues.length,
      risks: parsed.risks.length,
      fixes: parsed.exactFixes.length,
    },
  } as any;
}
