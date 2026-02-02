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

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
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
  const existing = chatTelegraphSettings.get(chatId);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatTelegraphSettings.set(chatId, defaults);
  saveSettings();
  return defaults;
}

export function setTelegraphEnabled(chatId: number, enabled: boolean): void {
  const settings = getTelegraphSettings(chatId);
  settings.enabled = enabled;
  saveSettings();
}

export function isTelegraphEnabled(chatId: number): boolean {
  return getTelegraphSettings(chatId).enabled;
}
