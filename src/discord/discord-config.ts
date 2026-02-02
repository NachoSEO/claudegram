import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = path.resolve(__dirname, '../..', '.env');
const envPath = process.env.CLAUDEGRAM_ENV_PATH || defaultEnvPath;
loadEnv({ path: envPath });

const discordEnvSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'Discord bot token is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'Discord application ID is required'),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_ALLOWED_USER_IDS: z
    .string()
    .min(1, 'At least one allowed Discord user ID is required')
    .transform((val) => val.split(',').map((id) => id.trim())),
  DISCORD_ALLOWED_ROLE_IDS: z
    .string()
    .optional()
    .transform((val) => val ? val.split(',').map((id) => id.trim()) : []),
  DISCORD_STREAMING_DEBOUNCE_MS: z
    .string()
    .default('1500')
    .transform((val) => parseInt(val, 10)),
  DISCORD_MAX_MESSAGE_LENGTH: z
    .string()
    .default('1900')
    .transform((val) => parseInt(val, 10)),
});

const parsed = discordEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid Discord configuration:');
  console.error(parsed.error.message);
  process.exit(1);
}

export const discordConfig = parsed.data;

export type DiscordConfig = typeof discordConfig;
