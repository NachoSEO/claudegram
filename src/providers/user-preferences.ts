import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

// Zod schema for user preferences
const userPreferencesSchema = z.object({
  provider: z.enum(['claude', 'opencode']).optional(),
  model: z.string().optional(),
  lastUpdated: z.string(),
});

const preferencesDataSchema = z.object({
  users: z.record(z.string(), userPreferencesSchema),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

const PREFS_DIR = path.join(os.homedir(), '.claudegram');
const PREFS_FILE = path.join(PREFS_DIR, 'user-preferences.json');

class UserPreferencesManager {
  private data: Record<number, UserPreferences> = {};

  constructor() {
    this.ensureDirectory();
    this.load();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(PREFS_DIR)) {
      fs.mkdirSync(PREFS_DIR, { recursive: true, mode: 0o700 });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(PREFS_FILE)) {
        const content = fs.readFileSync(PREFS_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        const validated = preferencesDataSchema.parse(parsed);
        // Convert string keys back to numbers
        this.data = Object.fromEntries(
          Object.entries(validated.users).map(([k, v]) => [parseInt(k, 10), v])
        ) as Record<number, UserPreferences>;
      }
    } catch (err) {
      console.error('[UserPreferences] Failed to load preferences:', err);
      this.data = {};
    }
  }

  private save(): void {
    try {
      const toSave = {
        users: Object.fromEntries(
          Object.entries(this.data).map(([k, v]) => [k, v])
        ),
      };
      atomicWriteFileSync(PREFS_FILE, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[UserPreferences] Failed to save preferences:', err);
    }
  }

  getProvider(chatId: number): 'claude' | 'opencode' | undefined {
    return this.data[chatId]?.provider;
  }

  setProvider(chatId: number, provider: 'claude' | 'opencode'): void {
    if (!this.data[chatId]) {
      this.data[chatId] = { lastUpdated: new Date().toISOString() };
    }
    this.data[chatId].provider = provider;
    this.data[chatId].lastUpdated = new Date().toISOString();
    this.save();
  }

  getModel(chatId: number): string | undefined {
    return this.data[chatId]?.model;
  }

  setModel(chatId: number, model: string): void {
    if (!this.data[chatId]) {
      this.data[chatId] = { lastUpdated: new Date().toISOString() };
    }
    this.data[chatId].model = model;
    this.data[chatId].lastUpdated = new Date().toISOString();
    this.save();
  }

  clearModel(chatId: number): void {
    if (this.data[chatId]) {
      delete this.data[chatId].model;
      this.data[chatId].lastUpdated = new Date().toISOString();
      this.save();
    }
  }

  clearPreferences(chatId: number): void {
    delete this.data[chatId];
    this.save();
  }
}

export const userPreferences = new UserPreferencesManager();
