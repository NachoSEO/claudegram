import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { config } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DroidOptions {
  model?: string;
  auto?: 'low' | 'medium' | 'high';
  cwd?: string;
  sessionId?: string;
  useSpec?: string;
  timeoutMs?: number;
}

export interface DroidResult {
  result: string;
  sessionId?: string;
  durationMs: number;
  isError: boolean;
  numTurns?: number;
}

export interface DroidStreamEvent {
  type: 'system' | 'message' | 'tool_call' | 'tool_result' | 'completion' | 'result' | 'error';
  data: any;
}

// ── Helpers ──────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function resolveDroidBinary(): string {
  // Look for `droid` binary (not the wrapper)
  const candidates = [
    expandTilde('~/.local/bin/droid'),
    '/usr/local/bin/droid',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: try the config path (might point to the wrapper or binary)
  const fromConfig = expandTilde(config.DROID_EXEC_PATH);
  if (existsSync(fromConfig)) return fromConfig;
  throw new Error('droid binary not found. Install Factory Droid or update DROID_EXEC_PATH.');
}

function buildArgs(prompt: string, outputMode: 'json' | 'stream-json', opts: DroidOptions): string[] {
  // Call `droid exec` directly (not the wrapper) so we can pass --output-format
  const args: string[] = ['exec'];

  args.push('--output-format', outputMode);
  args.push('--auto', opts.auto ?? 'low');

  if (opts.model) {
    args.push('--model', opts.model);
  } else {
    args.push('--model', config.DROID_DEFAULT_MODEL);
  }

  if (opts.sessionId) {
    args.push('--session-id', opts.sessionId);
  }

  if (opts.cwd) {
    args.push('--cwd', opts.cwd);
  }

  // Spec file: read and prepend to prompt
  if (opts.useSpec) {
    const specPath = expandTilde(opts.useSpec);
    if (existsSync(specPath)) {
      const specContent = readFileSync(specPath, 'utf-8');
      args.push(specContent + '\n\n' + prompt);
    } else {
      args.push(prompt);
    }
  } else {
    args.push(prompt);
  }

  return args;
}

function spawnDroid(args: string[], timeoutMs: number): { proc: ChildProcess; kill: () => void } {
  const droidBin = resolveDroidBinary();
  console.log(`[Droid] Spawning: ${droidBin} ${args.slice(0, 4).join(' ')} ... (timeout ${timeoutMs}ms)`);
  const proc = spawn(droidBin, args, {
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5_000);
  }, timeoutMs);

  const kill = () => {
    clearTimeout(timer);
    if (!proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5_000);
    }
  };

  proc.on('exit', () => clearTimeout(timer));
  proc.on('error', () => clearTimeout(timer));

  return { proc, kill };
}

// ── JSON mode (single result) ────────────────────────────────────────

export async function execDroidJSON(prompt: string, opts: DroidOptions = {}): Promise<DroidResult> {
  const timeoutMs = opts.timeoutMs ?? config.DROID_TIMEOUT_MS;
  const args = buildArgs(prompt, 'json', opts);
  const { proc, kill } = spawnDroid(args, timeoutMs);

  return new Promise<DroidResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('error', (err) => {
      kill();
      reject(new Error(`Failed to spawn droid-exec: ${err.message}`));
    });

    proc.on('exit', (code) => {
      kill();
      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

      if (stderr) {
        console.error('[Droid] stderr:', stderr.slice(0, 500));
      }

      if (!stdout) {
        reject(new Error(`droid-exec returned empty output (exit code ${code}). ${stderr.slice(0, 300)}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          result: parsed.result ?? stdout,
          sessionId: parsed.session_id,
          durationMs: parsed.duration_ms ?? 0,
          isError: parsed.is_error ?? (code !== 0),
          numTurns: parsed.num_turns,
        });
      } catch {
        // droid-exec might return plain text if -o json isn't supported by version
        resolve({
          result: stdout,
          durationMs: 0,
          isError: code !== 0,
        });
      }
    });
  });
}

// ── Stream mode (JSONL events) ───────────────────────────────────────

export async function* execDroidStream(prompt: string, opts: DroidOptions = {}): AsyncGenerator<DroidStreamEvent> {
  const timeoutMs = opts.timeoutMs ?? config.DROID_TIMEOUT_MS;
  const args = buildArgs(prompt, 'stream-json', opts);
  const { proc, kill } = spawnDroid(args, timeoutMs);

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const type = event.type ?? 'message';
        yield { type, data: event } as DroidStreamEvent;

        // If this is a completion event, we're done
        if (type === 'result' || (type === 'completion')) {
          break;
        }
      } catch {
        // Non-JSON line — treat as plain message
        yield { type: 'message', data: { content: trimmed } };
      }
    }
  } finally {
    kill();
  }
}
