/**
 * Terminal UI settings per chat.
 * Persists user preferences for terminal-style display mode.
 */

import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';

// Zod schema for terminal UI settings
const terminalSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

// Zod schema for the full settings file
const terminalSettingsFileSchema = z.object({
  settings: z.record(z.string(), terminalSettingsSchema),
});

export interface TerminalUISettings {
  enabled: boolean;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'terminal-ui-settings.json');
const chatTerminalSettings: Map<number, TerminalUISettings> = new Map();

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

function normalizeSettings(settings?: Partial<TerminalUISettings>): TerminalUISettings {
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.TERMINAL_UI_DEFAULT,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate with Zod schema
    const result = terminalSettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[TerminalUI] Invalid settings file format, starting fresh:', result.error.message);
      return;
    }

    for (const [chatId, settings] of Object.entries(result.data.settings)) {
      const id = Number(chatId);
      if (!Number.isFinite(id)) continue;
      chatTerminalSettings.set(id, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[TerminalUI] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, TerminalUISettings> = {};
  for (const [chatId, value] of chatTerminalSettings.entries()) {
    settings[String(chatId)] = value;
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2));
  } catch (error) {
    console.error('[TerminalUI] Failed to save settings:', error);
  }
}

loadSettings();

export function getTerminalUISettings(chatId: number): TerminalUISettings {
  const existing = chatTerminalSettings.get(chatId);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatTerminalSettings.set(chatId, defaults);
  saveSettings();
  return defaults;
}

export function setTerminalUIEnabled(chatId: number, enabled: boolean): void {
  const settings = getTerminalUISettings(chatId);
  settings.enabled = enabled;
  saveSettings();
}

export function isTerminalUIEnabled(chatId: number): boolean {
  return getTerminalUISettings(chatId).enabled;
}
