#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

interface JobEvent {
  type: string;
  jobId?: string;
  state?: string;
  message?: string;
  level?: string;
  at?: number;
  [k: string]: unknown;
}

const root = process.cwd();
const jobsPath = path.join(root, '.claudegram', 'jobs', 'jobs.jsonl');
const logPath = path.join(root, 'logs', 'discord.prod.log');
const argJobId = process.argv.find((a) => a.startsWith('--job-id='))?.split('=')[1];
const argWindow = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? '30');

function readJsonl(filePath: string): JobEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out: JobEvent[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function tail(filePath: string, bytes = 25000): string {
  if (!fs.existsSync(filePath)) return '';
  const st = fs.statSync(filePath);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

const events = readJsonl(jobsPath);
const now = Date.now();
const cutoff = now - argWindow * 60_000;
const recent = events.filter((e) => typeof e.at === 'number' && (e.at as number) >= cutoff);

const jobs = new Map<string, JobEvent[]>();
for (const e of recent) {
  if (!e.jobId) continue;
  if (!jobs.has(e.jobId)) jobs.set(e.jobId, []);
  jobs.get(e.jobId)!.push(e);
}

const jobIds = argJobId ? [argJobId] : Array.from(jobs.keys()).slice(-10);

let failed = false;
console.log(`Portable Jobs Smoke — window=${argWindow}m jobs=${jobIds.length}`);

for (const id of jobIds) {
  const evs = (jobs.get(id) ?? []).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (!evs.length) {
    console.log(`- ${id}: NO_EVENTS_IN_WINDOW`);
    failed = true;
    continue;
  }
  const started = evs.some((e) => e.type === 'job:start');
  const ended = evs.some((e) => e.type === 'job:end');
  const end = evs.findLast((e) => e.type === 'job:end');
  const hasProviderDiag = evs.some((e) => e.type === 'job:log' && typeof e.message === 'string' && e.message.includes('[provider:'));
  const state = end?.state ?? (started ? 'running' : 'queued');
  const ok = started && ended;
  if (!ok) failed = true;
  console.log(`- ${id}: state=${state} started=${started} ended=${ended} providerDiag=${hasProviderDiag}`);
}

const logTail = tail(logPath);
const hasWatcher = /watchdog|stalled|timeout/i.test(logTail);
console.log(`- logTail: watchdogSignals=${hasWatcher}`);

if (failed) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('RESULT: PASS');
