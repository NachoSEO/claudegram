import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TTSSettings {
  enabled: boolean;
  voice: string;
  autoplay: boolean;
}

interface TTSSettingsFile {
  settings: Record<string, TTSSettings>;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'tts-settings.json');
const chatTTSSettings: Map<number, TTSSettings> = new Map();

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

const GROQ_TTS_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] as const;
const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral',
  'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

function getDefaultVoice(): string {
  if (config.TTS_PROVIDER === 'groq') {
    // If the configured TTS_VOICE is valid for Groq, use it; otherwise default to 'troy'
    const voices: readonly string[] = GROQ_TTS_VOICES;
    return voices.includes(config.TTS_VOICE) ? config.TTS_VOICE : 'troy';
  }
  return config.TTS_VOICE;
}

function isValidVoiceForProvider(voice: string): boolean {
  const voices: readonly string[] = config.TTS_PROVIDER === 'groq' ? GROQ_TTS_VOICES : OPENAI_TTS_VOICES;
  return voices.includes(voice);
}

function normalizeSettings(settings?: Partial<TTSSettings>): TTSSettings {
  const voice = typeof settings?.voice === 'string' && settings.voice.length > 0
    ? settings.voice
    : getDefaultVoice();

  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : false,
    voice: isValidVoiceForProvider(voice) ? voice : getDefaultVoice(),
    autoplay: typeof settings?.autoplay === 'boolean' ? settings.autoplay : true,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as TTSSettingsFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.settings) return;
    for (const [chatId, settings] of Object.entries(parsed.settings)) {
      const id = Number(chatId);
      if (!Number.isFinite(id)) continue;
      chatTTSSettings.set(id, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[TTS] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, TTSSettings> = {};
  for (const [chatId, value] of chatTTSSettings.entries()) {
    settings[String(chatId)] = value;
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2));
  } catch (error) {
    console.error('[TTS] Failed to save settings:', error);
  }
}

loadSettings();

export function getTTSSettings(chatId: number): TTSSettings {
  const existing = chatTTSSettings.get(chatId);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatTTSSettings.set(chatId, defaults);
  saveSettings();
  return defaults;
}

export function setTTSEnabled(chatId: number, enabled: boolean): void {
  const settings = getTTSSettings(chatId);
  settings.enabled = enabled;
  saveSettings();
}

export function setTTSVoice(chatId: number, voice: string): void {
  const settings = getTTSSettings(chatId);
  settings.voice = voice;
  saveSettings();
}

export function setTTSAutoplay(chatId: number, autoplay: boolean): void {
  const settings = getTTSSettings(chatId);
  settings.autoplay = autoplay;
  saveSettings();
}

export function isTTSEnabled(chatId: number): boolean {
  return getTTSSettings(chatId).enabled;
}
