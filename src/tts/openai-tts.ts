import OpenAI from 'openai';
import { config } from '../config.js';

let openai: OpenAI | null = null;

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  return Math.min(4.0, Math.max(0.25, speed));
}

export async function generateSpeech(text: string, voice?: string): Promise<Buffer> {
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
