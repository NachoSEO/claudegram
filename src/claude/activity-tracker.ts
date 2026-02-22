/**
 * Activity Tracker — records live execution state per session for /peek.
 *
 * Each session can have at most one active query. The tracker stores
 * tool invocations, timing data, and the latest text snippet so that
 * /peek can display what Claude is currently doing.
 */

export interface ActivityState {
  startTime: number;
  lastEventTime: number;
  toolsUsed: string[];
  currentTool: { name: string; detail?: string } | null;
  toolCount: number;
  lastTextSnippet: string;
}

const activities: Map<string, ActivityState> = new Map();

export function startActivity(sessionKey: string): void {
  const now = Date.now();
  activities.set(sessionKey, {
    startTime: now,
    lastEventTime: now,
    toolsUsed: [],
    currentTool: null,
    toolCount: 0,
    lastTextSnippet: '',
  });
}

export function recordToolStart(sessionKey: string, toolName: string, detail?: string): void {
  const state = activities.get(sessionKey);
  if (!state) return;
  state.lastEventTime = Date.now();
  state.currentTool = { name: toolName, detail };
  state.toolsUsed.push(toolName);
  state.toolCount++;
}

export function recordToolEnd(sessionKey: string): void {
  const state = activities.get(sessionKey);
  if (!state) return;
  state.lastEventTime = Date.now();
  state.currentTool = null;
}

export function recordTextProgress(sessionKey: string, text: string): void {
  const state = activities.get(sessionKey);
  if (!state) return;
  state.lastEventTime = Date.now();
  state.lastTextSnippet = text.slice(-100);
}

export function recordEvent(sessionKey: string): void {
  const state = activities.get(sessionKey);
  if (!state) return;
  state.lastEventTime = Date.now();
}

export function clearActivity(sessionKey: string): void {
  activities.delete(sessionKey);
}

export function getActivity(sessionKey: string): ActivityState | undefined {
  return activities.get(sessionKey);
}
