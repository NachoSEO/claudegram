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
  workingDirectory: string;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  getSession(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey);
  }

  createSession(sessionKey: string, workingDirectory: string, conversationId?: string): Session {
    const resolved = resolveWorkingDirectory(workingDirectory);
    const session: Session = {
      conversationId: conversationId || this.generateConversationId(),
      claudeSessionId: undefined,
      workingDirectory: resolved,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);

    // Persist to history
    sessionHistory.saveSession(sessionKey, session.conversationId, resolved, '', session.claudeSessionId);

    return session;
  }

  updateActivity(sessionKey: string, messagePreview?: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastActivity = new Date();

      // Update history with last message preview
      if (messagePreview) {
        sessionHistory.updateLastMessage(sessionKey, session.conversationId, messagePreview);
      }
    }
  }

  setWorkingDirectory(sessionKey: string, directory: string): Session {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      // Clear Claude session ID when directory changes — the Agent SDK session
      // is bound to the original cwd and cannot be resumed with a different one.
      if (existing.workingDirectory !== directory) {
        existing.claudeSessionId = undefined;
      }
      existing.workingDirectory = directory;
      existing.lastActivity = new Date();
      // Save updated session
      sessionHistory.saveSession(sessionKey, existing.conversationId, directory, '', existing.claudeSessionId);
      return existing;
    }
    return this.createSession(sessionKey, directory);
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    // Note: We don't clear history here - history is for resuming past sessions
  }

  resumeSession(sessionKey: string, conversationId: string): Session | undefined {
    const historyEntry = sessionHistory.getSessionByConversationId(sessionKey, conversationId);
    if (!historyEntry) {
      return undefined;
    }

    const resolvedPath = resolveWorkingDirectory(historyEntry.projectPath);
    const session: Session = {
      conversationId: historyEntry.conversationId,
      claudeSessionId: historyEntry.claudeSessionId,
      workingDirectory: resolvedPath,
      createdAt: new Date(historyEntry.createdAt),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);

    // Update history activity (with resolved path)
    sessionHistory.saveSession(sessionKey, conversationId, resolvedPath, historyEntry.lastMessagePreview, historyEntry.claudeSessionId);

    return session;
  }

  resumeLastSession(sessionKey: string): Session | undefined {
    const lastEntry = sessionHistory.getLastSession(sessionKey);
    if (!lastEntry) {
      return undefined;
    }

    return this.resumeSession(sessionKey, lastEntry.conversationId);
  }

  getSessionHistory(sessionKey: string, limit: number = 5): SessionHistoryEntry[] {
    return sessionHistory.getHistory(sessionKey, limit);
  }

  setClaudeSessionId(sessionKey: string, claudeSessionId: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.claudeSessionId = claudeSessionId;
    session.lastActivity = new Date();
    sessionHistory.updateClaudeSessionId(sessionKey, session.conversationId, claudeSessionId);
  }

  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export const sessionManager = new SessionManager();
