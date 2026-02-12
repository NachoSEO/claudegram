import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';

// Zod schema for Telegraph settings
const telegraphSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

// Zod schema for the full Telegraph settings file
const telegraphSettingsFileSchema = z.object({
  settings: z.record(z.string(), telegraphSettingsSchema),
});

export interface TelegraphSettings {
  enabled: boolean;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'telegraph-settings.json');
const chatTelegraphSettings: Map<number, TelegraphSettings> = new Map();

/**
 * Validate chatId is a finite positive integer to prevent injection.
 */
function validateChatId(chatId: number): void {
  if (!Number.isFinite(chatId) || chatId <= 0 || !Number.isInteger(chatId)) {
    throw new Error(`Invalid chatId: ${chatId}`);
  }
}

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Verify existing directory has correct permissions (owner-only)
    try {
      const stats = fs.statSync(SETTINGS_DIR);
      // Check if it's a directory and has restrictive permissions (mode 0o700)
      if (!stats.isDirectory()) {
        throw new Error(`${SETTINGS_DIR} exists but is not a directory`);
      }
      // On non-Windows, verify permissions
      if (process.platform !== 'win32') {
        const perms = stats.mode & 0o777;
        if (perms !== 0o700) {
          // Fix permissions if too permissive
          fs.chmodSync(SETTINGS_DIR, 0o700);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Telegraph] Directory permission check failed:', error);
      }
    }
  }
}

function normalizeSettings(settings?: Partial<TelegraphSettings>): TelegraphSettings {
  return {
    // Default to global config value if not set
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.TELEGRAPH_ENABLED,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate with Zod schema
    const result = telegraphSettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[Telegraph] Invalid settings file format, starting fresh:', result.error.message);
      return;
    }

    for (const [chatId, settings] of Object.entries(result.data.settings)) {
      const id = Number(chatId);
      if (!Number.isFinite(id)) continue;
      chatTelegraphSettings.set(id, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[Telegraph] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, TelegraphSettings> = {};
  for (const [chatId, value] of chatTelegraphSettings.entries()) {
    settings[String(chatId)] = value;
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[Telegraph] Failed to save settings:', error);
  }
}

loadSettings();

export function getTelegraphSettings(chatId: number): TelegraphSettings {
  validateChatId(chatId);

  const existing = chatTelegraphSettings.get(chatId);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatTelegraphSettings.set(chatId, defaults);
  saveSettings();
  return defaults;
}

export function setTelegraphEnabled(chatId: number, enabled: boolean): void {
  validateChatId(chatId);

  const settings = getTelegraphSettings(chatId);
  settings.enabled = enabled;
  saveSettings();
}

export function isTelegraphEnabled(chatId: number): boolean {
  return getTelegraphSettings(chatId).enabled;
}
