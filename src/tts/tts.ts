import OpenAI from 'openai';
import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { resolveBin } from '../utils/resolve-bin.js';

// ── OpenAI provider ────────────────────────────────────────────────

let openai: OpenAI | null = null;

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  return Math.min(4.0, Math.max(0.25, speed));
}

async function generateSpeechOpenAI(text: string, voice?: string): Promise<Buffer> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured.');
  }
  if (!openai) {
    openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  const model = config.TTS_MODEL;
  const client = openai as OpenAI;
  const payload: Parameters<typeof client.audio.speech.create>[0] = {
    model,
    voice: (voice || config.TTS_VOICE) as Parameters<typeof client.audio.speech.create>[0]['voice'],
    input: text,
    response_format: config.TTS_RESPONSE_FORMAT as Parameters<typeof client.audio.speech.create>[0]['response_format'],
    speed: clampSpeed(config.TTS_SPEED),
  };

  if (model.startsWith('gpt-4o-mini-tts')) {
    payload.instructions = config.TTS_INSTRUCTIONS;
  }

  const response = await client.audio.speech.create(payload);
  return Buffer.from(await response.arrayBuffer());
}

// ── Groq Orpheus provider ──────────────────────────────────────────

const GROQ_TTS_ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_MAX_CHARS = 200;

/**
 * Split text into chunks of at most maxLen characters, breaking at sentence
 * boundaries (.!?) first, then word boundaries, then hard-cutting.
 */
export function chunkText(text: string, maxLen: number = GROQ_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  // Split into sentences: split on .!? followed by whitespace or end-of-string
  const sentences: string[] = [];
  const sentenceRe = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let match;
  while ((match = sentenceRe.exec(text)) !== null) {
    const s = match[0].trim();
    if (s) sentences.push(s);
  }

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      // Flush current buffer
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      // Split long sentence at word boundaries
      const words = sentence.split(/\s+/);
      let wordBuf = '';
      for (const word of words) {
        if (word.length > maxLen) {
          // Hard-cut oversized word
          if (wordBuf) {
            chunks.push(wordBuf.trim());
            wordBuf = '';
          }
          for (let i = 0; i < word.length; i += maxLen) {
            chunks.push(word.slice(i, i + maxLen));
          }
        } else if (wordBuf.length + 1 + word.length > maxLen) {
          chunks.push(wordBuf.trim());
          wordBuf = word;
        } else {
          wordBuf = wordBuf ? `${wordBuf} ${word}` : word;
        }
      }
      if (wordBuf) {
        current = wordBuf;
      }
    } else if (current.length + 1 + sentence.length > maxLen) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

/**
 * Call the Groq Orpheus TTS API for a single chunk (≤200 chars).
 * Returns a WAV Buffer.
 */
async function groqTTSSingle(text: string, voice: string): Promise<Buffer> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured.');
  }

  const response = await fetch(GROQ_TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      input: text,
      voice,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq TTS API error ${response.status}: ${body.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Concatenate multiple WAV buffers and convert to OGG/Opus using ffmpeg.
 */
async function concatAndConvertAudio(wavBuffers: Buffer[]): Promise<Buffer> {
  if (wavBuffers.length === 0) {
    throw new Error('No audio buffers to concatenate.');
  }

  // Single buffer — just convert to ogg
  if (wavBuffers.length === 1) {
    return convertWavToOgg(wavBuffers[0]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-tts-'));

  try {
    // Write each WAV chunk
    const chunkPaths: string[] = [];
    for (let i = 0; i < wavBuffers.length; i++) {
      const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(3, '0')}.wav`);
      fs.writeFileSync(chunkPath, wavBuffers[i], { mode: 0o600 });
      chunkPaths.push(chunkPath);
    }

    // Write concat list
    const concatListPath = path.join(tmpDir, 'concat.txt');
    const concatContent = chunkPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent, { mode: 0o600 });

    // Run ffmpeg
    const outputPath = path.join(tmpDir, 'output.ogg');
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:a', 'libopus',
      '-b:a', '64k',
      outputPath,
    ]);

    return fs.readFileSync(outputPath);
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Convert a single WAV buffer to OGG/Opus.
 */
async function convertWavToOgg(wavBuffer: Buffer): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-tts-'));

  try {
    const inputPath = path.join(tmpDir, 'input.wav');
    const outputPath = path.join(tmpDir, 'output.ogg');
    fs.writeFileSync(inputPath, wavBuffer, { mode: 0o600 });

    await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-c:a', 'libopus',
      '-b:a', '64k',
      outputPath,
    ]);

    return fs.readFileSync(outputPath);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(resolveBin('ffmpeg'), args, { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg failed: ${(stderr || error.message).slice(0, 500)}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Generate speech using Groq Orpheus TTS.
 * Handles chunking for long text and converts WAV→OGG/Opus.
 */
async function generateSpeechGroq(text: string, voice?: string): Promise<Buffer> {
  const selectedVoice = voice || config.TTS_VOICE;
  const chunks = chunkText(text, GROQ_MAX_CHARS);

  console.log(`[TTS/Groq] Generating speech: ${chunks.length} chunk(s), voice=${selectedVoice}`);

  const wavBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    const wav = await groqTTSSingle(chunk, selectedVoice);
    wavBuffers.push(wav);
  }

  return concatAndConvertAudio(wavBuffers);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Generate speech using the configured TTS provider.
 * Returns an audio Buffer (format depends on provider:
 *   - groq: OGG/Opus
 *   - openai: format from TTS_RESPONSE_FORMAT config)
 */
export async function generateSpeech(text: string, voice?: string): Promise<Buffer> {
  if (config.TTS_PROVIDER === 'groq') {
    return generateSpeechGroq(text, voice);
  }
  return generateSpeechOpenAI(text, voice);
}
