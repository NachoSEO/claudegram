import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, 'At least one allowed user ID is required')
    .transform((val) => val.split(',').map((id) => parseInt(id.trim(), 10))),
  ANTHROPIC_API_KEY: z.string().optional(), // Optional - uses Claude Max subscription if not set
  // OpenAI (TTS)
  OPENAI_API_KEY: z.string().optional(),
  WORKSPACE_DIR: z.string().default(process.env.HOME || '.'),
  CLAUDE_EXECUTABLE_PATH: z.string().default('claude'),
  BOT_NAME: z.string().default('Claudegram'),
  STREAMING_MODE: z.enum(['streaming', 'wait']).default('streaming'),
  STREAMING_DEBOUNCE_MS: z
    .string()
    .default('500')
    .transform((val) => parseInt(val, 10)),
  MAX_MESSAGE_LENGTH: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
  // TTS Configuration
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('coral'),
  TTS_INSTRUCTIONS: z.string().default('Speak in a friendly, natural conversational tone.'),
  TTS_SPEED: z
    .string()
    .default('1.0')
    .transform((val) => parseFloat(val)),
  TTS_MAX_CHARS: z
    .string()
    .default('4096')
    .transform((val) => parseInt(val, 10)),
  TTS_RESPONSE_FORMAT: z.string().default('opus'),
  IMAGE_MAX_FILE_SIZE_MB: z
    .string()
    .default('20')
    .transform((val) => parseInt(val, 10)),
  // New config options
  DANGEROUS_MODE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  MAX_LOOP_ITERATIONS: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_JSON_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  // Reddit fetch configuration
  REDDITFETCH_PATH: z.string().default(''),
  REDDITFETCH_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_LIMIT: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_DEPTH: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  // Voice transcription (Groq Whisper)
  GROQ_API_KEY: z.string().optional(),
  GROQ_TRANSCRIBE_PATH: z.string().default(''),
  VOICE_SHOW_TRANSCRIPT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  VOICE_MAX_FILE_SIZE_MB: z
    .string()
    .default('19')
    .transform((val) => parseInt(val, 10)),
  VOICE_LANGUAGE: z.string().default('en'),
  VOICE_TIMEOUT_MS: z
    .string()
    .default('60000')
    .transform((val) => parseInt(val, 10)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

export type Config = typeof config;
