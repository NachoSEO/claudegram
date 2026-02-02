import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveBin } from '../../utils/resolve-bin.js';

/**
 * Resampler: Gemini PCM (24kHz mono s16le) → Discord PCM (48kHz stereo s16le).
 * Uses ffmpeg as a subprocess for sample-rate conversion and channel upmix.
 */
export interface Resampler {
  /** Write Gemini's 24k mono PCM here. */
  input: PassThrough;
  /** Read 48k stereo PCM from here (feed to Discord). */
  output: PassThrough;
  /** Kill the ffmpeg process. */
  kill: () => void;
  /** True if the ffmpeg process is still alive. */
  alive: boolean;
}

export function createPlaybackResampler(): Resampler {
  const input = new PassThrough();
  const output = new PassThrough();

  const ffmpeg = spawn(resolveBin('ffmpeg'), [
    '-loglevel', 'warning',
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  let alive = true;

  ffmpeg.on('error', (err) => {
    console.error('[PlaybackResampler] ffmpeg spawn error:', err.message);
    alive = false;
    output.destroy(err);
  });

  input.pipe(ffmpeg.stdin!);
  ffmpeg.stdout!.pipe(output);

  ffmpeg.on('exit', () => {
    alive = false;
    output.end();
  });

  ffmpeg.stdin!.on('error', () => { /* swallow broken pipe */ });

  return {
    input,
    output,
    kill: () => {
      alive = false;
      try { ffmpeg.kill('SIGKILL'); } catch { /* already dead */ }
      input.destroy();
      output.destroy();
    },
    get alive() { return alive; },
  };
}

/**
 * Resampler: Discord PCM (48kHz stereo s16le) → Gemini PCM (16kHz mono s16le).
 * Used for the receive path (user talking → Gemini input).
 */
export interface ReceiveResampler {
  /** Write Discord's 48k stereo PCM here. */
  input: PassThrough;
  /** Read 16k mono PCM from here (send to Gemini). */
  output: PassThrough;
  /** ffmpeg process ref. */
  process: ChildProcess;
  kill: () => void;
  alive: boolean;
}

export function createReceiveResampler(): ReceiveResampler {
  const input = new PassThrough();
  const output = new PassThrough();

  const ffmpeg = spawn(resolveBin('ffmpeg'), [
    '-loglevel', 'warning',
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  let alive = true;

  ffmpeg.on('error', (err) => {
    console.error('[ReceiveResampler] ffmpeg spawn error:', err.message);
    alive = false;
    output.destroy(err);
  });

  input.pipe(ffmpeg.stdin!);
  ffmpeg.stdout!.pipe(output);

  ffmpeg.on('exit', () => {
    alive = false;
    output.end();
  });

  ffmpeg.stdin!.on('error', () => { /* swallow broken pipe */ });

  return {
    input,
    output,
    process: ffmpeg,
    kill: () => {
      alive = false;
      try { ffmpeg.kill('SIGKILL'); } catch { /* already dead */ }
      input.destroy();
      output.destroy();
    },
    get alive() { return alive; },
  };
}
