import * as fs from 'fs';
import * as os from 'os';
import { sessionHistory, SessionHistoryEntry } from './session-history.js';

/**
 * Resolve a stored working directory to a valid path on this system.
 * Handles cross-OS portability (e.g. /Users/x saved on macOS, running on Linux).
 */
function resolveWorkingDirectory(storedPath: string): string {
  // If it exists, use as-is
  if (fs.existsSync(storedPath)) return storedPath;

  // Try remapping: replace the stored home prefix with the current $HOME
  // e.g. /Users/player3vsgpt/foo → /home/player3vsgpt/foo
  const home = os.homedir();
  const homePrefixes = ['/Users/', '/home/'];
  for (const prefix of homePrefixes) {
    if (storedPath.startsWith(prefix)) {
      // Extract everything after the username segment
      const rest = storedPath.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const remapped = slashIdx === -1 ? home : `${home}${rest.slice(slashIdx)}`;
      if (fs.existsSync(remapped)) return remapped;
    }
  }

  // Last resort: fall back to $HOME
  return home;
}

interface Session {
  conversationId: string;
  claudeSessionId?: string;
  openaiConversationId?: string;
  workingDirectory: string;
  /** Ephemeral index of recently uploaded image artifacts keyed by Discord message id. */
  images?: Record<string, { path: string; relativePath: string; caption?: string; createdAt: string }>;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<number, Session> = new Map();

  setImageArtifact(chatId: number, messageId: string, artifact: { path: string; relativePath: string; caption?: string }): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    if (!session.images) session.images = {};

    const keys = Object.keys(session.images);
    if (keys.length > 50) {
      keys
        .map((k) => ({ k, t: Date.parse(session.images?.[k]?.createdAt || '0') || 0 }))
        .sort((a, b) => a.t - b.t)
        .slice(0, Math.max(0, keys.length - 50))
        .forEach(({ k }) => { delete session.images?.[k]; });
    }

    session.images[messageId] = {
      path: artifact.path,
      relativePath: artifact.relativePath,
      caption: artifact.caption,
      createdAt: new Date().toISOString(),
    };
  }

  getImageArtifact(chatId: number, messageId: string): { path: string; relativePath: string; caption?: string; createdAt: string } | undefined {
    const session = this.sessions.get(chatId);
    return session?.images?.[messageId];
  }

  getSession(chatId: number): Session | undefined {
    return this.sessions.get(chatId);
  }

  createSession(chatId: number, workingDirectory: string, conversationId?: string): Session {
    const resolved = resolveWorkingDirectory(workingDirectory);
    const session: Session = {
      conversationId: conversationId || this.generateConversationId(),
      claudeSessionId: undefined,
      workingDirectory: resolved,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(chatId, session);

    // Persist to history
    sessionHistory.saveSession(chatId, session.conversationId, resolved, '', session.claudeSessionId);

    return session;
  }

  updateActivity(chatId: number, messagePreview?: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.lastActivity = new Date();

      // Update history with last message preview
      if (messagePreview) {
        sessionHistory.updateLastMessage(chatId, session.conversationId, messagePreview);
      }
    }
  }

  setWorkingDirectory(chatId: number, directory: string): Session {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.workingDirectory = directory;
      existing.lastActivity = new Date();
      // Save updated session
      sessionHistory.saveSession(chatId, existing.conversationId, directory, '', existing.claudeSessionId);
      return existing;
    }
    return this.createSession(chatId, directory);
  }

  clearSession(chatId: number): void {
    this.sessions.delete(chatId);
    // Note: We don't clear history here - history is for resuming past sessions
  }

  resumeSession(chatId: number, conversationId: string): Session | undefined {
    const historyEntry = sessionHistory.getSessionByConversationId(chatId, conversationId);
    if (!historyEntry) {
      return undefined;
    }

    const resolvedPath = resolveWorkingDirectory(historyEntry.projectPath);
    const session: Session = {
      conversationId: historyEntry.conversationId,
      claudeSessionId: historyEntry.claudeSessionId,
      openaiConversationId: historyEntry.openaiConversationId,
      workingDirectory: resolvedPath,
      createdAt: new Date(historyEntry.createdAt),
      lastActivity: new Date(),
    };
    this.sessions.set(chatId, session);

    // Update history activity (with resolved path)
    sessionHistory.saveSession(chatId, conversationId, resolvedPath, historyEntry.lastMessagePreview, historyEntry.claudeSessionId);

    return session;
  }

  resumeLastSession(chatId: number): Session | undefined {
    const lastEntry = sessionHistory.getLastSession(chatId);
    if (!lastEntry) {
      return undefined;
    }

    return this.resumeSession(chatId, lastEntry.conversationId);
  }

  getSessionHistory(chatId: number, limit: number = 5): SessionHistoryEntry[] {
    return sessionHistory.getHistory(chatId, limit);
  }

  setClaudeSessionId(chatId: number, claudeSessionId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    session.claudeSessionId = claudeSessionId;
    session.lastActivity = new Date();
    sessionHistory.updateClaudeSessionId(chatId, session.conversationId, claudeSessionId);
  }

  setOpenAIConversationId(chatId: number, openaiConvId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    session.openaiConversationId = openaiConvId;
    session.lastActivity = new Date();
    sessionHistory.updateOpenAIConversationId(chatId, session.conversationId, openaiConvId);
  }

  clearOpenAIConversationId(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    session.openaiConversationId = undefined;
    session.lastActivity = new Date();
    sessionHistory.clearOpenAIConversationId(chatId, session.conversationId);
  }

  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export const sessionManager = new SessionManager();
