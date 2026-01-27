import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionHistoryEntry {
  conversationId: string;
  claudeSessionId?: string;
  projectPath: string;
  projectName: string;
  lastMessagePreview: string;
  createdAt: string;
  lastActivity: string;
}

interface SessionHistoryData {
  sessions: Record<number, SessionHistoryEntry[]>; // chatId -> history entries
}

const HISTORY_DIR = path.join(os.homedir(), '.claudegram');
const HISTORY_FILE = path.join(HISTORY_DIR, 'sessions.json');
const MAX_HISTORY_PER_CHAT = 20;

class SessionHistory {
  private data: SessionHistoryData = { sessions: {} };

  constructor() {
    this.ensureDirectory();
    this.load();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
        this.data = JSON.parse(content);
      }
    } catch (error) {
      console.error('[SessionHistory] Failed to load:', error);
      this.data = { sessions: {} };
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[SessionHistory] Failed to save:', error);
    }
  }

  saveSession(
    chatId: number,
    conversationId: string,
    projectPath: string,
    lastMessagePreview: string = '',
    claudeSessionId?: string
  ): void {
    if (!this.data.sessions[chatId]) {
      this.data.sessions[chatId] = [];
    }

    const history = this.data.sessions[chatId];
    const projectName = path.basename(projectPath);

    // Check if this conversation already exists
    const existingIndex = history.findIndex(
      (entry) => entry.conversationId === conversationId
    );

    const existingEntry = existingIndex >= 0 ? history[existingIndex] : undefined;
    const entry: SessionHistoryEntry = {
      conversationId,
      claudeSessionId: claudeSessionId ?? existingEntry?.claudeSessionId,
      projectPath,
      projectName,
      lastMessagePreview: lastMessagePreview.substring(0, 100),
      createdAt:
        existingIndex >= 0
          ? history[existingIndex].createdAt
          : new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      // Update existing entry
      history[existingIndex] = entry;
    } else {
      // Add new entry at the beginning
      history.unshift(entry);
    }

    // Keep only recent history
    if (history.length > MAX_HISTORY_PER_CHAT) {
      this.data.sessions[chatId] = history.slice(0, MAX_HISTORY_PER_CHAT);
    }

    this.save();
  }

  getHistory(chatId: number, limit: number = 5): SessionHistoryEntry[] {
    const history = this.data.sessions[chatId] || [];
    return history.slice(0, limit);
  }

  getLastSession(chatId: number): SessionHistoryEntry | undefined {
    const history = this.data.sessions[chatId];
    return history?.[0];
  }

  getSessionByConversationId(
    chatId: number,
    conversationId: string
  ): SessionHistoryEntry | undefined {
    const history = this.data.sessions[chatId] || [];
    return history.find((entry) => entry.conversationId === conversationId);
  }

  getAllActiveSessions(): Map<number, SessionHistoryEntry> {
    const active = new Map<number, SessionHistoryEntry>();
    for (const [chatIdStr, history] of Object.entries(this.data.sessions)) {
      const chatId = parseInt(chatIdStr, 10);
      if (history.length > 0) {
        active.set(chatId, history[0]);
      }
    }
    return active;
  }

  updateLastMessage(chatId: number, conversationId: string, preview: string): void {
    const history = this.data.sessions[chatId];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.lastMessagePreview = preview.substring(0, 100);
      entry.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  updateClaudeSessionId(chatId: number, conversationId: string, claudeSessionId: string): void {
    const history = this.data.sessions[chatId];
    if (!history) return;

    const entry = history.find((e) => e.conversationId === conversationId);
    if (entry) {
      entry.claudeSessionId = claudeSessionId;
      entry.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  clearHistory(chatId: number): void {
    delete this.data.sessions[chatId];
    this.save();
  }
}

export const sessionHistory = new SessionHistory();
