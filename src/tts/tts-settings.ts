import { config } from '../config.js';

export interface TTSSettings {
  enabled: boolean;
  voice: string;
}

const chatTTSSettings: Map<number, TTSSettings> = new Map();

export function getTTSSettings(chatId: number): TTSSettings {
  const existing = chatTTSSettings.get(chatId);
  if (existing) return existing;

  const defaults: TTSSettings = {
    enabled: false,
    voice: config.TTS_VOICE,
  };
  chatTTSSettings.set(chatId, defaults);
  return defaults;
}

export function setTTSEnabled(chatId: number, enabled: boolean): void {
  const settings = getTTSSettings(chatId);
  settings.enabled = enabled;
}

export function setTTSVoice(chatId: number, voice: string): void {
  const settings = getTTSSettings(chatId);
  settings.voice = voice;
}

export function isTTSEnabled(chatId: number): boolean {
  return getTTSSettings(chatId).enabled;
}
