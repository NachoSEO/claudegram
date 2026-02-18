import { Context, InputFile } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import {
  clearConversation,
  sendToAgent,
  sendLoopToAgent,
  setModel,
  getModel,
  isDangerousMode,
  getCachedUsage,
} from '../../claude/agent.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import {
  cancelRequest,
  resetRequest,
  clearQueue,
  isProcessing,
  queueRequest,
  setAbortController,
} from '../../claude/request-queue.js';
import { createTelegraphFromFile, createTelegraphPage } from '../../telegram/telegraph.js';
import { isMediumUrl, fetchMediumArticle, FreediumArticle } from '../../medium/freedium.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { getTTSSettings, setTTSEnabled, setTTSVoice, setTTSAutoplay } from '../../tts/tts-settings.js';
import { getTerminalUISettings, setTerminalUIEnabled } from '../../telegram/terminal-settings.js';
import { getTelegraphSettings, setTelegraphEnabled } from '../../telegram/telegraph-settings.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { transcribeFile, downloadTelegramAudio } from '../../audio/transcribe.js';
import { executeVReddit } from '../../reddit/vreddit.js';
import { redditFetch, redditFetchBoth, type RedditFetchOptions } from '../../reddit/redditfetch.js';
import { fmtTokens, getProgressBar } from './message.handler.js';
import {
  detectPlatform,
  platformLabel,
  isValidUrl,
  extractMedia,
  cleanupExtractResult,
  type ExtractMode,
  type ExtractResult,
  type SubtitleFormat,
} from '../../media/extract.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';

// Helper for consistent MarkdownV2 replies
async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

function buildFeatureDisabledMessage(feature: string): string {
  return `⚠️ ${feature} feature is disabled in configuration.`;
}

async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(buildFeatureDisabledMessage(feature), { parse_mode: undefined });
}

/** Build status lines appended to project confirmation messages. */
export function projectStatusSuffix(chatId: number): string {
  const model = getModel(chatId);
  const dangerous = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';
  const session = sessionManager.getSession(chatId);
  const created = session?.createdAt
    ? new Date(session.createdAt).toLocaleString()
    : new Date().toLocaleString();
  const sessionId = session?.claudeSessionId;

  let suffix = `\n• *Model:* ${esc(model)}\n• *Created:* ${esc(created)}\n• *Dangerous Mode:* ${esc(dangerous)}`;
  if (sessionId) {
    suffix += `\n• *Session ID:* \`${esc(sessionId)}\``;
    suffix += `\n\n💡 To continue this session from the terminal, copy the command below\\.`;
  } else {
    suffix += `\n• *Session ID:* _pending — send a message to start_`;
  }
  return suffix;
}

/** The copyable command sent as a separate message. */
export function resumeCommandMessage(sessionId: string): string {
  return `\`claude --resume ${sessionId}\``;
}

const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral',
  'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

const GROQ_TTS_VOICES = [
  'autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy',
] as const;

function getActiveTTSVoices(): readonly string[] {
  return config.TTS_PROVIDER === 'groq' ? GROQ_TTS_VOICES : OPENAI_TTS_VOICES;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const BOTCTL_PATH = path.join(PROJECT_ROOT, 'scripts', 'claudegram-botctl.sh');
const PROJECT_BROWSER_PAGE_SIZE = 8;

type ProjectBrowserState = {
  root: string;
  current: string;
  page: number;
};

const projectBrowserState = new Map<number, ProjectBrowserState>();

function botctlExists(): boolean {
  return fs.existsSync(BOTCTL_PATH);
}

type TTSMenuMode = 'main' | 'voices';

function parseContextOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '⚠️ No context output received.';
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let model = '';
  let tokensLine = '';
  const categories: Array<{ name: string; tokens: string; percent: string }> = [];
  let inCategories = false;

  for (const line of lines) {
    if (/^model:/i.test(line)) {
      model = line.replace(/^model:/i, '').trim();
      continue;
    }
    if (/^tokens:/i.test(line)) {
      tokensLine = line.replace(/^tokens:/i, '').trim();
      continue;
    }
    if (/estimated usage by category/i.test(line)) {
      inCategories = true;
      continue;
    }
    if (inCategories) {
      if (/^category/i.test(line)) continue;
      if (/^-+$/.test(line)) continue;

      const match = line.match(/^(.+?)\s{2,}([0-9.,kKmM]+)\s+([0-9.,]+%)$/);
      if (match) {
        categories.push({ name: match[1].trim(), tokens: match[2], percent: match[3] });
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 3 && parts[parts.length - 1].endsWith('%')) {
        const percent = parts.pop() as string;
        const tokens = parts.pop() as string;
        const name = parts.join(' ');
        categories.push({ name, tokens, percent });
      }
    }
  }

  if (!model && !tokensLine && categories.length === 0) {
    return `## 🧠 Context Usage\n\n\`\`\`\n${trimmed}\n\`\`\``;
  }

  let output = '## 🧠 Context Usage';
  if (model) output += `\n- **Model:** ${model}`;
  if (tokensLine) output += `\n- **Tokens:** ${tokensLine}`;

  if (categories.length > 0) {
    output += '\n\n### Estimated usage by category';
    for (const category of categories) {
      output += `\n- **${category.name}:** ${category.tokens} (${category.percent})`;
    }
  }

  output += '\n\n_If this looks stale, send a new message then run /context again._';
  return output;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

async function runClaudeContext(sessionId: string, cwd: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session ID format');
  }
  return new Promise((resolve, reject) => {
    execFile(
      config.CLAUDE_EXECUTABLE_PATH,
      ['-p', '--resume', sessionId, '/context'],
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          reject(new Error(message || 'Failed to run /context'));
          return;
        }
        resolve((stdout || stderr || '').trim());
      }
    );
  });
}

function buildTTSMenu(chatId: number, mode: TTSMenuMode) {
  const settings = getTTSSettings(chatId);
  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  const apiStatus = hasKey ? 'configured' : 'missing';
  const providerLabel = config.TTS_PROVIDER === 'groq' ? 'Groq Orpheus' : 'OpenAI';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const autoplayLine = settings.autoplay ? 'ON' : 'OFF';
  const header = `🔊 *Voice Replies*`;
  const baseText =
    `${header}\n\n` +
    `Provider: *${esc(providerLabel)}*\n` +
    `Status: *${statusLine}*\n` +
    `Voice: *${esc(settings.voice)}*\n` +
    `Autoplay: *${autoplayLine}*\n` +
    `API key: *${esc(apiStatus)}*`;

  if (mode === 'voices') {
    const voices = getActiveTTSVoices();
    const voiceRows: { text: string; callback_data: string }[][] = [];
    const chunkSize = 3;
    for (let i = 0; i < voices.length; i += chunkSize) {
      const chunk = voices.slice(i, i + chunkSize);
      voiceRows.push(chunk.map((voice) => ({
        text: voice === settings.voice ? `✓ ${voice}` : voice,
        callback_data: `tts:voice:${voice}`,
      })));
    }

    const recommended = config.TTS_PROVIDER === 'groq'
      ? 'autumn, troy'
      : 'marin, cedar';

    return {
      text:
        `${header}\n\n` +
        `Pick a voice\\.\nRecommended: ${esc(recommended)}\\.`,
      keyboard: [
        ...voiceRows,
        [{ text: 'Back', callback_data: 'tts:back' }],
      ],
    };
  }

  const autoplayLabel = settings.autoplay ? '✓ Autoplay' : 'Autoplay';

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'tts:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'tts:off' },
      ],
      [
        { text: `Voice: ${settings.voice}`, callback_data: 'tts:voices' },
        { text: autoplayLabel, callback_data: 'tts:autoplay' },
      ],
    ],
  };
}

function buildTelegraphMenu(chatId: number) {
  const settings = getTelegraphSettings(chatId);
  const globalEnabled = config.TELEGRAPH_ENABLED;
  const globalStatus = globalEnabled ? 'enabled' : 'disabled';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const header = `📄 *Instant View \\(Telegraph\\)*`;

  const baseText =
    `${header}\n\n` +
    `Status: *${statusLine}*\n` +
    `Global config: *${esc(globalStatus)}*\n\n` +
    `_When enabled, long responses and tables are rendered as Telegraph articles with Instant View\\._`;

  // If global config is disabled, show warning and no toggle
  if (!globalEnabled) {
    return {
      text:
        `${header}\n\n` +
        `⚠️ *Disabled globally*\n\n` +
        `Telegraph is disabled in the bot configuration\\.\n` +
        `Set \`TELEGRAPH_ENABLED=true\` in \\.env to enable\\.`,
      keyboard: [],
    };
  }

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'telegraph:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'telegraph:off' },
      ],
    ],
  };
}

export async function handleStart(ctx: Context): Promise<void> {
  const dangerousWarning = isDangerousMode()
    ? '\n\n⚠️ *DANGEROUS MODE ENABLED* \\- All tool permissions auto\\-approved'
    : '';

  const welcomeMessage = `👋 *Welcome to Claudegram\\!*

I bridge your messages to Claude Code running on your local machine\\.

*Getting Started:*
1\\. Set your project directory with \`/project /path/to/project\`
2\\. Start chatting with Claude about your code\\!

*Commands:*
• \`/project <path>\` \\- Open a project
• \`/newproject <name>\` \\- Create a new project
• \`/clear\` \\- Clear session and start fresh
• \`/status\` \\- Show current session info
• \`/commands\` \\- Show all available commands

Current mode: ${config.STREAMING_MODE}${dangerousWarning}`;

  await replyMd(ctx, welcomeMessage);
}

export async function handleClear(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  const projectName = session ? path.basename(session.workingDirectory) : 'current session';

  await ctx.reply(
    `⚠️ *Clear Session?*\n\nThis will clear *${esc(projectName)}* and all conversation history\\.\n\n_This cannot be undone\\._`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✓ Yes, clear it', callback_data: 'clear:confirm' },
            { text: '✗ Cancel', callback_data: 'clear:cancel' },
          ],
        ],
      },
    }
  );
}

export async function handleClearCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('clear:')) return;

  const action = data.replace('clear:', '');

  if (action === 'confirm') {
    sessionManager.clearSession(chatId);
    clearConversation(chatId);

    await ctx.answerCallbackQuery({ text: 'Session cleared!' });
    await ctx.editMessageText(
      '🔄 Session cleared\\.\n\nUse /project to set a new working directory\\.',
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageText('👍 Clear cancelled\\. Your session is intact\\.', { parse_mode: 'MarkdownV2' });
  }
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('project:')) return;

  const state = getProjectState(chatId);
  const action = data.split(':')[1] || '';

  if (action === 'manual') {
    await ctx.answerCallbackQuery();
    await sendProjectManualPrompt(ctx);
    return;
  }

  if (action === 'use') {
    sessionManager.setWorkingDirectory(chatId, state.current);
    clearConversation(chatId);

    await ctx.answerCallbackQuery({ text: 'Project set' });
    await ctx.editMessageText(
      `✅ Project: *${esc(path.basename(state.current))}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(chatId)}`,
      { parse_mode: 'MarkdownV2' }
    );

    const s = sessionManager.getSession(chatId);
    if (s?.claudeSessionId) {
      await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
    }
    return;
  }

  if (action === 'up') {
    const parent = path.dirname(state.current);
    if (isWithinRoot(state.root, parent)) {
      state.current = parent;
      state.page = 0;
    }
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }

  if (action === 'page') {
    const direction = data.split(':')[2];
    if (direction === 'next') state.page += 1;
    if (direction === 'prev') state.page = Math.max(0, state.page - 1);
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }

  if (action === 'refresh') {
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }

  if (action === 'open') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const entries = listDirectories(state.current);
    const selected = entries[index];
    if (!selected) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendProjectBrowser(ctx, state, true);
      return;
    }
    const nextPath = path.join(state.current, selected);
    // Resolve symlinks before checking boundaries
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(nextPath);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Path not accessible' });
      return;
    }
    if (!isWithinRoot(state.root, resolvedPath)) {
      await ctx.answerCallbackQuery({ text: 'Outside workspace' });
      return;
    }
    state.current = resolvedPath;
    state.page = 0;
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }
}

function getProjectRoot(): string {
  return getWorkspaceRoot();
}

// Use shared isPathWithinRoot from workspace-guard for symlink-safe path validation
const isWithinRoot = isPathWithinRoot;

function listDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function shortenName(name: string, maxLength: number = 24): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 1)}…`;
}

function buildProjectBrowserText(state: ProjectBrowserState, totalDirs: number, totalPages: number): string {
  const pageNumber = totalPages === 0 ? 1 : state.page + 1;
  const safePath = esc(state.current);

  return (
    `📁 *Project Browser*\n\n` +
    `*Current:* \`${safePath}\`\n` +
    `*Folders:* ${totalDirs}\n` +
    `*Page:* ${pageNumber}/${Math.max(totalPages, 1)}\n\n` +
    `Select a folder below, or use the current folder\\.`
  );
}

function buildProjectBrowserKeyboard(state: ProjectBrowserState, entries: string[], totalPages: number): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows: { text: string; callback_data: string }[][] = [];
  const pageOffset = state.page * PROJECT_BROWSER_PAGE_SIZE;

  for (let i = 0; i < entries.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    const first = entries[i];
    const second = entries[i + 1];

    if (first) {
      const index = pageOffset + i;
      row.push({ text: `📁 ${shortenName(first)}`, callback_data: `project:open:${index}` });
    }
    if (second) {
      const index = pageOffset + i + 1;
      row.push({ text: `📁 ${shortenName(second)}`, callback_data: `project:open:${index}` });
    }
    if (row.length > 0) rows.push(row);
  }

  const navRow: { text: string; callback_data: string }[] = [];
  if (state.current !== state.root) {
    navRow.push({ text: '⬆️ Up', callback_data: 'project:up' });
  }
  navRow.push({ text: '✅ Use this folder', callback_data: 'project:use' });
  navRow.push({ text: '✍️ Enter path', callback_data: 'project:manual' });
  rows.push(navRow);

  const pageRow: { text: string; callback_data: string }[] = [];
  if (state.page > 0) {
    pageRow.push({ text: '◀️ Prev', callback_data: 'project:page:prev' });
  }
  if (state.page < totalPages - 1) {
    pageRow.push({ text: 'Next ▶️', callback_data: 'project:page:next' });
  }
  if (pageRow.length > 0) {
    rows.push(pageRow);
  }

  rows.push([{ text: '🔄 Refresh', callback_data: 'project:refresh' }]);

  return { inline_keyboard: rows };
}

async function sendProjectBrowser(ctx: Context, state: ProjectBrowserState, edit: boolean): Promise<void> {
  const allEntries = listDirectories(state.current);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PROJECT_BROWSER_PAGE_SIZE));
  const page = Math.min(Math.max(state.page, 0), totalPages - 1);
  state.page = page;

  const pageEntries = allEntries.slice(page * PROJECT_BROWSER_PAGE_SIZE, (page + 1) * PROJECT_BROWSER_PAGE_SIZE);
  const text = buildProjectBrowserText(state, allEntries.length, totalPages);
  const replyMarkup = buildProjectBrowserKeyboard(state, pageEntries, totalPages);

  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup });
      return;
    } catch {
      // fall through to send new message
    }
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup });
}

async function sendProjectManualPrompt(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = sessionManager.getSession(chatId);
  const currentInfo = session
    ? `\n\n_Current: ${esc(path.basename(session.workingDirectory))}_`
    : '';

  await ctx.reply(
    `📁 *Set Project Directory*${currentInfo}\n\n👇 _Enter the path below:_`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '/home/user/projects/myapp',
        selective: true,
      },
    }
  );
}

function getProjectState(chatId: number): ProjectBrowserState {
  const root = getProjectRoot();
  const existing = projectBrowserState.get(chatId);
  if (existing && existing.root === root) {
    if (!isWithinRoot(root, existing.current)) {
      existing.current = root;
      existing.page = 0;
    }
    // Refresh timestamp on access to keep active sessions alive
    projectBrowserTimestamps.set(chatId, Date.now());
    return existing;
  }

  const session = sessionManager.getSession(chatId);
  let initial = root;
  if (session && isWithinRoot(root, session.workingDirectory)) {
    initial = session.workingDirectory;
  }

  const state: ProjectBrowserState = {
    root,
    current: path.resolve(initial),
    page: 0,
  };
  projectBrowserState.set(chatId, state);
  projectBrowserTimestamps.set(chatId, Date.now());
  return state;
}

export async function handleProject(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  // No args - prompt for input with ForceReply
  if (!args) {
    const state = getProjectState(chatId);
    await sendProjectBrowser(ctx, state, false);
    return;
  }

  let projectPath: string;
  const workspaceRoot = getWorkspaceRoot();

  if (args.startsWith('/') || args.startsWith('~')) {
    projectPath = args;
    if (projectPath.startsWith('~')) {
      projectPath = path.join(process.env.HOME || '', projectPath.slice(1));
    }
    projectPath = path.resolve(projectPath);
    if (!isPathWithinRoot(workspaceRoot, projectPath)) {
      await replyMd(ctx, `❌ Path must be within workspace root: \`${esc(workspaceRoot)}\``);
      return;
    }
  } else {
    projectPath = path.join(workspaceRoot, args);
  }

  if (!fs.existsSync(projectPath)) {
    await replyMd(ctx, `📁 Project "${esc(args)}" doesn't exist\\.\n\nCreate it? Use: \`/newproject ${esc(args)}\``);
    return;
  }

  if (!fs.statSync(projectPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is not a directory: \`${esc(projectPath)}\``);
    return;
  }

  sessionManager.setWorkingDirectory(chatId, projectPath);
  clearConversation(chatId);

  await replyMd(ctx, `✅ Project: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(chatId)}`);

  const s = sessionManager.getSession(chatId);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

export async function handleNewProject(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await replyMd(ctx, 'Usage: `/newproject <name>`');
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(args)) {
    await replyMd(ctx, '❌ Project name can only contain letters, numbers, dashes and underscores\\.');
    return;
  }

  const projectPath = path.join(config.WORKSPACE_DIR, args);

  if (fs.existsSync(projectPath)) {
    await replyMd(ctx, `❌ Project "${esc(args)}" already exists\\. Use \`/project ${esc(args)}\` to open it\\.`);
    return;
  }

  fs.mkdirSync(projectPath, { recursive: true, mode: 0o700 });
  sessionManager.setWorkingDirectory(chatId, projectPath);
  clearConversation(chatId);

  await replyMd(ctx, `✅ Created and opened: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(chatId)}`);

  const s = sessionManager.getSession(chatId);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

function listProjects(): string[] {
  try {
    const entries = fs.readdirSync(config.WORKSPACE_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listProjectFiles(projectPath: string, maxDepth: number = 2): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number, prefix: string = '') {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          files.push(relativePath);
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, entry.name), depth + 1, relativePath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(projectPath, 0);
  // Sort by common file types first (README, package.json, src files)
  return files.sort((a, b) => {
    const priority = (f: string) => {
      if (f === 'README.md') return 0;
      if (f === 'package.json') return 1;
      if (f.startsWith('src/')) return 2;
      if (f.endsWith('.md')) return 3;
      return 4;
    };
    return priority(a) - priority(b);
  });
}

function listMarkdownFiles(projectPath: string, maxDepth: number = 3): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number, prefix: string = '') {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.md' || ext === '.markdown') {
            files.push(relativePath);
          }
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, entry.name), depth + 1, relativePath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(projectPath, 0);
  // Sort README first, then by path
  return files.sort((a, b) => {
    const priority = (f: string) => {
      if (f === 'README.md') return 0;
      if (f === 'CHANGELOG.md') return 1;
      if (f.includes('docs/')) return 2;
      return 3;
    };
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

export async function handleStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session\\.\n\nUse `/project /path/to/project` to get started\\.');
    return;
  }

  const currentModel = getModel(chatId);
  const dangerousMode = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';

  let status = `📊 *Session Status*

• *Working Directory:* \`${esc(session.workingDirectory)}\`
• *Session ID:* \`${esc(session.conversationId)}\`
• *Model:* ${esc(currentModel)}
• *Created:* ${esc(session.createdAt.toLocaleString())}
• *Last Activity:* ${esc(session.lastActivity.toLocaleString())}
• *Mode:* ${esc(config.STREAMING_MODE)}
• *Dangerous Mode:* ${esc(dangerousMode)}
• *Uptime:* ${esc(getUptimeFormatted())}`;

  const cached = getCachedUsage(chatId);
  if (cached) {
    const pct = cached.contextWindow > 0
      ? Math.round(((cached.inputTokens + cached.outputTokens) / cached.contextWindow) * 100)
      : 0;
    status += `\n• *Context:* ${esc(String(pct))}% \\(${esc(fmtTokens(cached.inputTokens + cached.outputTokens))}/${esc(fmtTokens(cached.contextWindow))}\\)`;
    status += `\n• *Session Cost:* \\$${esc(cached.totalCostUsd.toFixed(4))}`;
  }

  await replyMd(ctx, status);
}

// Runtime streaming mode (can be toggled, defaults to config)
let runtimeStreamingMode: 'streaming' | 'wait' = config.STREAMING_MODE;

export function getStreamingMode(): 'streaming' | 'wait' {
  return runtimeStreamingMode;
}

export async function handleMode(ctx: Context): Promise<void> {
  const keyboard = [
    [
      {
        text: runtimeStreamingMode === 'streaming' ? '✓ Streaming' : 'Streaming',
        callback_data: 'mode:streaming'
      },
      {
        text: runtimeStreamingMode === 'wait' ? '✓ Wait' : 'Wait',
        callback_data: 'mode:wait'
      },
    ],
  ];

  const description = runtimeStreamingMode === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.reply(
    `⚙️ *Response Mode*\n\nCurrent: *${runtimeStreamingMode}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleModeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('mode:')) return;

  const newMode = data.replace('mode:', '') as 'streaming' | 'wait';
  runtimeStreamingMode = newMode;

  const description = newMode === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.answerCallbackQuery({ text: `Mode set to ${newMode}!` });
  await ctx.editMessageText(
    `✅ Mode set to *${esc(newMode)}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handleTerminalUI(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const settings = getTerminalUISettings(chatId);
  const currentStatus = settings.enabled ? 'ON' : 'OFF';

  const keyboard = [
    [
      {
        text: settings.enabled ? '✓ On' : 'On',
        callback_data: 'terminalui:on'
      },
      {
        text: !settings.enabled ? '✓ Off' : 'Off',
        callback_data: 'terminalui:off'
      },
    ],
  ];

  const description = settings.enabled
    ? '_Shows spinner animations and tool status during operations_'
    : '_Classic streaming mode with simple cursor_';

  await ctx.reply(
    `🖥️ *Terminal UI Mode*\n\nCurrent: *${currentStatus}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleTerminalUICallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('terminalui:')) return;

  const newState = data.replace('terminalui:', '') === 'on';
  setTerminalUIEnabled(chatId, newState);

  const statusText = newState ? 'ON' : 'OFF';
  const description = newState
    ? '_Shows spinner animations and tool status during operations_'
    : '_Classic streaming mode with simple cursor_';

  await ctx.answerCallbackQuery({ text: `Terminal UI ${statusText}!` });
  await ctx.editMessageText(
    `✅ Terminal UI *${statusText}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handleTTS(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const menu = buildTTSMenu(chatId, 'main');

  await ctx.reply(menu.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

export async function handleTTSCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('tts:')) return;

  if (data === 'tts:on') {
    const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
    const keyName = config.TTS_PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    if (!hasKey) {
      await ctx.answerCallbackQuery({ text: `${keyName} missing. Set it in .env and restart.` });
      setTTSEnabled(chatId, false);
    } else {
      setTTSEnabled(chatId, true);
    }
  } else if (data === 'tts:off') {
    setTTSEnabled(chatId, false);
  } else if (data === 'tts:autoplay') {
    const current = getTTSSettings(chatId);
    setTTSAutoplay(chatId, !current.autoplay);
  } else if (data.startsWith('tts:voice:')) {
    const voice = data.replace('tts:voice:', '');
    const voices = getActiveTTSVoices();
    if (voices.includes(voice)) {
      setTTSVoice(chatId, voice);
    }
  }

  const mode: TTSMenuMode = data === 'tts:voices' || data.startsWith('tts:voice:')
    ? 'voices'
    : 'main';
  const menu = buildTTSMenu(chatId, mode);

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    // Ignore "message is not modified" — happens with duplicate callbacks
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      throw error;
    }
  }
}

export async function handleTelegraphCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('telegraph:')) return;

  // Don't allow enabling if global config is disabled
  if (data === 'telegraph:on') {
    if (!config.TELEGRAPH_ENABLED) {
      await ctx.answerCallbackQuery({ text: 'Telegraph disabled in config. Set TELEGRAPH_ENABLED=true in .env.' });
      setTelegraphEnabled(chatId, false);
    } else {
      setTelegraphEnabled(chatId, true);
    }
  } else if (data === 'telegraph:off') {
    setTelegraphEnabled(chatId, false);
  }

  const menu = buildTelegraphMenu(chatId);

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    // Ignore "message is not modified" — happens with duplicate callbacks
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      throw error;
    }
  }
}

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await replyMd(ctx, `🏓 Pong\\!\n\nUptime: ${esc(uptime)}`);
}

export async function handleContext(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Try cached SDK usage first (instant, no CLI shell-out)
  const cached = getCachedUsage(chatId);
  if (cached) {
    const pct = cached.contextWindow > 0
      ? Math.round(((cached.inputTokens + cached.outputTokens + cached.cacheReadTokens) / cached.contextWindow) * 100)
      : 0;
    const bar = getProgressBar(pct);

    const output = `## 🧠 Context Usage\n\n`
      + `${bar} **${pct}%** of context window\n\n`
      + `- **Model:** ${cached.model}\n`
      + `- **Input tokens:** ${fmtTokens(cached.inputTokens)}\n`
      + `- **Output tokens:** ${fmtTokens(cached.outputTokens)}\n`
      + `- **Cache read:** ${fmtTokens(cached.cacheReadTokens)}\n`
      + `- **Cache write:** ${fmtTokens(cached.cacheWriteTokens)}\n`
      + `- **Context window:** ${fmtTokens(cached.contextWindow)}\n`
      + `- **Turns this session:** ${cached.numTurns}\n`
      + `- **Cost this query:** $${cached.totalCostUsd.toFixed(4)}\n\n`
      + `_Data from last query. Send a message then run /context for fresh data._`;

    await messageSender.sendMessage(ctx, output);
    return;
  }

  // Fallback: CLI shell-out approach
  if (!session.claudeSessionId) {
    await replyMd(
      ctx,
      '⚠️ No Claude session ID found\\.\n\nSend a message to Claude after resuming, then run `/context` again\\.'
    );
    return;
  }

  const ack = await ctx.reply('🧠 Checking context...', { parse_mode: undefined });

  try {
    const raw = await runClaudeContext(session.claudeSessionId, session.workingDirectory);
    const formatted = parseContextOutput(raw);
    await messageSender.sendMessage(ctx, formatted);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = message.toLowerCase().includes('unknown') || message.toLowerCase().includes('command')
      ? '\n\nThis CLI may not support `/context` yet.'
      : '';
    await messageSender.sendMessage(ctx, `❌ Failed to fetch context: ${message}${hint}`);
  } finally {
    try {
      await ctx.api.deleteMessage(chatId, ack.message_id);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function handleBotStatus(ctx: Context): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = Math.floor(uptimeSec % 60);
  const uptimeStr = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  const mode = config.BOT_MODE === 'prod' ? 'Production' : 'Development';
  const chatId = ctx.chat?.id;
  const model = chatId ? getModel(chatId) : 'opus';
  const streaming = config.STREAMING_MODE || 'streaming';
  const pid = process.pid;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);

  const msg =
    `🟢 *${esc(config.BOT_NAME)} is running*\n\n` +
    `*Mode:* ${esc(mode)}\n` +
    `*Uptime:* ${esc(uptimeStr)}\n` +
    `*PID:* ${pid}\n` +
    `*Memory:* ${esc(memMB)} MB\n` +
    `*Model:* ${esc(model)}\n` +
    `*Streaming:* ${esc(streaming)}`;

  await replyMd(ctx, msg);
}

export async function handleRestartBot(ctx: Context): Promise<void> {
  if (!botctlExists()) {
    await replyMd(ctx, '❌ Bot control script not found\\.\n\nExpected at `scripts/claudegram-botctl.sh`\\.');
    return;
  }

  await replyMd(
    ctx,
    '🔁 Restarting bot\\.\n\n⏳ Please wait at least *10\\-15 seconds* before checking status or resuming\\.'
  );

  // Send restore buttons immediately — the process gets killed too fast for a delayed send
  const chatId = ctx.chat?.id;
  if (chatId) {
    try {
      await ctx.api.sendMessage(chatId, '👇 Restore your session after restart:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '▶️ Continue', callback_data: 'restart:continue' },
              { text: '📜 Resume', callback_data: 'restart:resume' },
            ],
          ],
        },
      });
    } catch (e) {
      console.debug('[RestartBot] Failed to send restore buttons:', e instanceof Error ? e.message : e);
    }
  }

  try {
    const child = spawn(
      BOTCTL_PATH,
      ['recover'],
      { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, MODE: config.BOT_MODE } }
    );
    child.unref();
  } catch (error) {
    console.error('[BotCtl] Failed to restart:', sanitizeError(error));
  }
}

export async function handleRestartCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'restart:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'restart:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

export async function handleCancel(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const wasProcessing = isProcessing(chatId);
  const cancelled = await cancelRequest(chatId);
  const clearedCount = clearQueue(chatId);

  if (cancelled || clearedCount > 0) {
    let message = '🛑 Cancelled\\.';
    if (clearedCount > 0) {
      message += ` \\(${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared\\)`;
    }
    await replyMd(ctx, message);
  } else if (!wasProcessing) {
    await replyMd(ctx, 'ℹ️ Nothing to cancel\\.');
  }
}

export async function handleReset(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const wasProcessing = isProcessing(chatId);
  const reset = await resetRequest(chatId);
  clearQueue(chatId);

  // Clear the session so user starts fresh
  clearConversation(chatId);
  sessionManager.clearSession(chatId);

  if (wasProcessing || reset) {
    await replyMd(ctx, '🔄 Session reset\\. Current request cancelled and session cleared\\.');
  } else {
    await replyMd(ctx, '🔄 Session reset\\.');
  }

  // Show restore buttons (same UX as /restartbot)
  try {
    await ctx.api.sendMessage(chatId, '👇 Restore or start a new session:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '▶️ Continue', callback_data: 'reset:continue' },
            { text: '📜 Resume', callback_data: 'reset:resume' },
          ],
        ],
      },
    });
  } catch (e) {
    console.debug('[Reset] Failed to send restore buttons:', e instanceof Error ? e.message : e);
  }
}

export async function handleResetCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'reset:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'reset:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

export async function handleCommands(ctx: Context): Promise<void> {
  await replyMd(ctx, getAvailableCommands());
}

export async function handleModelCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim().toLowerCase();

  const validModels = ['sonnet', 'opus', 'haiku'];

  if (!args) {
    const currentModel = getModel(chatId);

    // Show inline keyboard for model selection
    const keyboard = validModels.map((model) => {
      const isCurrent = model === currentModel;
      const label = isCurrent ? `✓ ${model}` : model;
      return [{ text: label, callback_data: `model:${model}` }];
    });

    await ctx.reply(
      `🤖 *Select Model*\n\n_Current: ${esc(currentModel)}_\n\n• *opus* \\- Most capable \\(default\\)\n• *sonnet* \\- Balanced\n• *haiku* \\- Fast & light`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
    return;
  }

  if (!validModels.includes(args)) {
    await replyMd(ctx, `❌ Unknown model "${esc(args)}"\\.\n\nAvailable: ${validModels.join(', ')}`);
    return;
  }

  setModel(chatId, args);
  await replyMd(ctx, `✅ Model set to *${esc(args)}*`);
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('model:')) return;

  const model = data.replace('model:', '');
  const validModels = ['sonnet', 'opus', 'haiku'];

  if (!validModels.includes(model)) {
    await ctx.answerCallbackQuery({ text: 'Invalid model' });
    return;
  }

  setModel(chatId, model);

  await ctx.answerCallbackQuery({ text: `Model set to ${model}!` });
  await ctx.editMessageText(
    `✅ Model set to *${esc(model)}*`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handlePlan(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `📋 *Plan Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will analyze your task and create a detailed implementation plan before coding\\.\n\n👇 _Describe your task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Add user authentication with JWT...',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(chatId, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'plan',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleExplore(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const question = text.split(' ').slice(1).join(' ').trim();

  if (!question) {
    await ctx.reply(
      `🔍 *Explore Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will search and analyze the codebase to answer your question\\.\n\n👇 _What would you like to know?_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'How does the auth system work?',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(chatId, question, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, question, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'explore',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleResume(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const history = sessionManager.getSessionHistory(chatId, 10);
  // Only show sessions that actually have a Claude session (were chatted in)
  const resumable = history.filter((entry) => entry.claudeSessionId);

  if (resumable.length === 0) {
    await replyMd(ctx, 'ℹ️ No resumable sessions found\\.\n\nSessions need at least one Claude response to be resumable\\.\nUse `/project <name>` to start a new session\\.');
    return;
  }

  const keyboard = resumable.map((entry) => {
    const date = new Date(entry.lastActivity);
    const timeAgo = formatTimeAgo(date);

    return [
      {
        text: `${entry.projectName} (${timeAgo})`,
        callback_data: `resume:${entry.conversationId}`,
      },
    ];
  });

  await ctx.reply('📜 *Recent Sessions*\n\nSelect a session to resume:', {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('resume:')) return;

  const conversationId = data.replace('resume:', '');
  const session = sessionManager.resumeSession(chatId, conversationId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }

  clearConversation(chatId);

  await ctx.answerCallbackQuery({ text: 'Session resumed!' });
  await ctx.editMessageText(
    `✅ Resumed session for *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(chatId)}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }
}

export async function handleContinue(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.resumeLastSession(chatId);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No previous session to continue\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  clearConversation(chatId);

  await replyMd(ctx,
    `✅ Continuing *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(chatId)}`
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }
}

export async function handleLoop(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `🔄 *Loop Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will work iteratively until done \\(max ${config.MAX_LOOP_ITERATIONS} iterations\\)\\.\n\n👇 _Describe the task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Fix all TypeScript errors in src/',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(chatId, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendLoopToAgent(chatId, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleSessions(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const history = sessionManager.getSessionHistory(chatId, 10);
  const currentSession = sessionManager.getSession(chatId);

  if (history.length === 0 && !currentSession) {
    await replyMd(ctx, 'ℹ️ No sessions found\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  let message = '📋 *Sessions*\n\n';

  if (currentSession) {
    message += `*Active:*\n• \`${esc(path.basename(currentSession.workingDirectory))}\` \\(${esc(formatTimeAgo(currentSession.lastActivity))}\\)\n\n`;
  }

  if (history.length > 0) {
    message += '*Recent:*\n';
    for (const entry of history) {
      const isActive = currentSession && currentSession.conversationId === entry.conversationId;
      const marker = isActive ? '→ ' : '• ';
      const date = new Date(entry.lastActivity);
      message += `${marker}\`${esc(entry.projectName)}\` \\(${esc(formatTimeAgo(date))}\\)\n`;
    }
  }

  message += '\n_Use `/resume` to switch sessions or `/continue` to resume the last one\\._';

  await replyMd(ctx, message);
}

export async function handleTeleport(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session to teleport\\.\n\nStart a conversation first with `/project <name>`\\.');
    return;
  }

  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ No Claude session available yet\\.\n\nSend a message first to start a session, then use `/teleport`\\.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const claudeBin = config.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  const command = `cd "${session.workingDirectory}" && ${claudeBin} --resume ${session.claudeSessionId}`;

  const message = `🚀 *Teleport to Terminal*

*Project:* \`${esc(projectName)}\`
*Session:* \`${esc(session.claudeSessionId.substring(0, 8))}\\.\\.\\.\`

Copy and run in your terminal:

\`\`\`
${esc(command)}
\`\`\`

_Both Telegram and terminal can continue independently \\(forked session\\)\\._`;

  await replyMd(ctx, message);
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export async function handleFile(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  if (!filePath) {
    // List some files in the project to help user
    const projectFiles = listProjectFiles(session.workingDirectory);
    const fileList = projectFiles.length > 0
      ? `\n\n*Recent files:*\n${projectFiles.slice(0, 8).map(f => `• \`${esc(f)}\``).join('\n')}`
      : '';

    await ctx.reply(
      `📎 *Download File*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_${fileList}\n\n👇 _Enter the file path:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'src/index.ts',
          selective: true,
        },
      }
    );
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is a directory, not a file: \`${esc(filePath)}\``);
    return;
  }

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await replyMd(ctx, '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.');
  }
}

export async function handleTelegraph(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  // If no argument provided, show the settings menu
  if (!filePath) {
    const menu = buildTelegraphMenu(chatId);
    await ctx.reply(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: menu.keyboard.length > 0 ? { inline_keyboard: menu.keyboard } : undefined,
    });
    return;
  }

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await replyMd(ctx, '⚠️ Telegraph works best with Markdown files \\(\\.md\\)');
  }

  await replyMd(ctx, '📤 Creating Telegraph page\\.\\.\\.');

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await replyMd(ctx, `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`);
  } else {
    await replyMd(ctx, '❌ Failed to create Telegraph page\\.');
  }
}

/**
 * Tokenize a user-provided argument string, preserving quoted substrings.
 * Returns an array of individual arguments safe for execFile.
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"| '([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

type RedditFormat = 'markdown' | 'json';

function parseRedditArgs(tokens: string[]): {
  cleanTokens: string[];
  format: RedditFormat | null;
  hadOutputFlag: boolean;
} {
  const cleanTokens: string[] = [];
  let format: RedditFormat | null = null;
  let hadOutputFlag = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-o' || token === '--output') {
      hadOutputFlag = true;
      i++; // skip value
      continue;
    }

    if ((token === '-f' || token === '--format') && tokens[i + 1]) {
      const next = tokens[i + 1] as RedditFormat;
      if (next === 'json' || next === 'markdown') {
        format = next;
      }
      i++; // skip value, don't push to cleanTokens (handled here)
      continue;
    }

    cleanTokens.push(token);
  }

  return { cleanTokens, format, hadOutputFlag };
}

function ensureRedditOutputDir(ctx: Context): string {
  const chatId = ctx.chat?.id;
  const session = chatId ? sessionManager.getSession(chatId) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const dir = path.join(baseDir, '.claudegram', 'reddit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function buildRedditOutputPath(ctx: Context, tokens: string[]): string {
  const dir = ensureRedditOutputDir(ctx);
  const raw = tokens[0] || 'reddit';
  const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'reddit';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `reddit_${slug}_${stamp}.json`);
}

function slugFromUrl(input: string): string {
  const cleaned = input.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return cleaned.slice(0, 60) || 'medium';
}

function ensureMediumOutputDir(ctx: Context, url: string): string {
  const chatId = ctx.chat?.id;
  const session = chatId ? sessionManager.getSession(chatId) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const slug = slugFromUrl(url);
  const dir = path.join(baseDir, '.claudegram', 'medium', slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


// Pending Reddit fetch results keyed by messageId, with 5-min TTL.
// Keyed by messageId (not chatId) so concurrent fetches don't overwrite each other.
const pendingRedditResults = new Map<number, {
  chatId: number;
  output: string;
  jsonOutput: string;
  targets: string[];
  options: RedditFetchOptions;
  format: RedditFormat | null;
  hadOutputFlag: boolean;
  expiresAt: number;
}>();
const REDDIT_RESULT_TTL_MS = 5 * 60 * 1000;

/**
 * Execute native Reddit fetch, cache the result, and show an inline picker
 * so the user can choose File / Chat / Both.
 * Exported so message.handler.ts can reuse it for ForceReply flow.
 */
export async function executeRedditFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const tokens = tokenizeArgs(args);
  const { cleanTokens, format, hadOutputFlag } = parseRedditArgs(tokens);

  // Extract targets and options from cleanTokens
  const targets: string[] = [];
  const options: RedditFetchOptions = {
    format: format || 'markdown',
    limit: config.REDDITFETCH_DEFAULT_LIMIT,
    depth: config.REDDITFETCH_DEFAULT_DEPTH,
  };

  const VALID_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
  const VALID_TIMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);

  for (let i = 0; i < cleanTokens.length; i++) {
    const token = cleanTokens[i];
    if (token === '--sort' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_SORTS.has(val)) options.sort = val;
    } else if (token === '--limit' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if ((token === '-l') && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if (token === '--depth' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.depth = parsed;
    } else if (token === '--time' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_TIMES.has(val)) options.timeFilter = val;
    } else {
      targets.push(token);
    }
  }

  if (targets.length === 0) {
    await replyMd(ctx, '❌ No target specified\\. Example: `/reddit r/ClaudeAI` or `/reddit <post\\-url>`');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    // Fetch both formats in a single API call to avoid double-dipping
    const { markdown: output, json: jsonOutput } = await redditFetchBoth(targets, options);

    if (!output.trim()) {
      await replyMd(ctx, '❌ No results returned\\.');
      return;
    }

    // Build a short preview for the picker message
    const charCount = output.length;
    const targetLabel = targets.join(', ');
    const previewSnippet = output.length > 200
      ? output.slice(0, 200).trimEnd() + '...'
      : output;

    const previewText =
      `📡 *Reddit Fetch*\n` +
      `Target: \`${esc(targetLabel)}\`\n` +
      `Size: _${charCount} chars_\n\n` +
      `${esc(previewSnippet)}\n\n` +
      `_Choose how to consume this content:_`;

    const msg = await ctx.reply(previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 File', callback_data: 'reddit_action:file' },
            { text: '💬 Chat', callback_data: 'reddit_action:chat' },
            { text: '📄💬 Both', callback_data: 'reddit_action:both' },
          ],
        ],
      },
    });

    // Cache both formats for callback handling (keyed by messageId)
    pendingRedditResults.set(msg.message_id, {
      chatId,
      output,
      jsonOutput,
      targets,
      options,
      format,
      hadOutputFlag,
      expiresAt: Date.now() + REDDIT_RESULT_TTL_MS,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    let userMessage: string;

    if (errorMessage.includes('Missing Reddit credentials') || errorMessage.includes('REDDIT_CLIENT_ID')) {
      userMessage = "❌ Reddit credentials not configured\\.\n\nSet `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` in claudegram's `\\.env` file\\.";
    } else if (errorMessage.includes('timed out') || errorMessage.includes('AbortError')) {
      userMessage = '❌ Reddit fetch timed out\\.';
    } else {
      userMessage = `❌ Reddit fetch failed: ${esc(sanitizeError(errorMessage).substring(0, 300))}`;
    }

    await replyMd(ctx, userMessage);
  }
}

/**
 * Handle inline keyboard callbacks for Reddit action picker (File / Chat / Both).
 */
export async function handleRedditActionCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('reddit_action:')) return;

  const action = data.replace('reddit_action:', '');

  // Look up pending result by messageId (keyed by picker message ID)
  const callbackMsgId = ctx.callbackQuery?.message?.message_id;
  if (!callbackMsgId) return;
  const pending = pendingRedditResults.get(callbackMsgId);
  if (!pending || Date.now() > pending.expiresAt) {
    if (callbackMsgId) pendingRedditResults.delete(callbackMsgId);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  await ctx.answerCallbackQuery();

  const { output, jsonOutput, targets, format, hadOutputFlag } = pending;
  const doFile = action === 'file' || action === 'both';
  const doChat = action === 'chat' || action === 'both';

  try {
    // ── File mode ──────────────────────────────────────────────────
    if (doFile) {
      // Large thread JSON fallback (uses cached JSON, no second API call)
      if (!format && output.length > config.REDDITFETCH_JSON_THRESHOLD_CHARS) {
        try {
          const outputPath = buildRedditOutputPath(ctx, targets);
          fs.writeFileSync(outputPath, jsonOutput, { encoding: 'utf-8', mode: 0o600 });

          const sent = await messageSender.sendDocument(
            ctx,
            outputPath,
            `📎 Reddit JSON saved: ${path.basename(outputPath)}`
          );

          const displayPath = `.claudegram/reddit/${path.basename(outputPath)}`;
          const notice = sent
            ? `Large thread detected \\(${output.length} chars\\) — sent JSON file for structured review\\.`
            : `Large thread detected \\(${output.length} chars\\) — JSON saved at \`${esc(displayPath)}\`\\.`;

          await replyMd(ctx, notice);
        } catch (jsonError) {
          console.error('[Reddit] JSON fallback failed:', jsonError);
          await messageSender.sendMessage(ctx, output);
        }
      } else {
        await messageSender.sendMessage(ctx, output);
      }

      if (hadOutputFlag) {
        await replyMd(ctx, 'ℹ️ Note: `-o/--output` is ignored in this picker flow\\. JSON is saved automatically for large threads\\.');
      }
    }

    // ── Chat mode ──────────────────────────────────────────────────
    if (doChat) {
      const session = sessionManager.getSession(chatId);
      if (!session) {
        await replyMd(ctx, '⚠️ No project set\\. Use `/project` first to enable Chat mode\\.');
      } else {
        // 1. Save content to disk
        const dir = ensureRedditOutputDir(ctx);
        const slug = (targets[0] || 'reddit').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const mdPath = path.join(dir, `reddit_${slug}_${stamp}.md`);
        fs.writeFileSync(mdPath, output, { encoding: 'utf-8', mode: 0o600 });

        // 2. Build prompt with inline content (truncated for large results)
        const CHAT_INLINE_LIMIT = 3000;
        const truncated = output.length > CHAT_INLINE_LIMIT;
        const inlineContent = truncated
          ? output.slice(0, CHAT_INLINE_LIMIT).trimEnd()
          : output;

        // Use relative display path to avoid leaking absolute server paths in conversation
        const displayPath = `.claudegram/reddit/${path.basename(mdPath)}`;

        let prompt = `I just fetched Reddit content and saved it to ${displayPath}. Here's the content:\n\n${inlineContent}`;
        if (truncated) {
          prompt += `\n\n[Content truncated — full content (${output.length} chars) is saved at ${displayPath}.]`;
        }
        prompt += '\n\nPlease summarize the key points and let me know if you have any questions.';

        // 3. Queue a streaming response
        try {
          await queueRequest(chatId, prompt, async () => {
            if (getStreamingMode() === 'streaming') {
              await messageSender.startStreaming(ctx);
              const abortController = new AbortController();
              setAbortController(chatId, abortController);
              try {
                const response = await sendToAgent(chatId, prompt, {
                  onProgress: (progressText) => {
                    messageSender.updateStream(ctx, progressText);
                  },
                  abortController,
                });
                await messageSender.finishStreaming(ctx, response.text);
                await maybeSendVoiceReply(ctx, response.text);
              } catch (error) {
                await messageSender.cancelStreaming(ctx);
                throw error;
              }
            } else {
              await ctx.replyWithChatAction('typing');
              const abortController = new AbortController();
              setAbortController(chatId, abortController);
              const response = await sendToAgent(chatId, prompt, { abortController });
              await messageSender.sendMessage(ctx, response.text);
              await maybeSendVoiceReply(ctx, response.text);
            }
          });
        } catch (error) {
          if ((error as Error).message !== 'Queue cleared') {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await replyMd(ctx, `❌ Chat failed: ${esc(errorMessage)}`);
          }
        }
      }
    }

    // Edit the original picker message to show what was selected
    const actionLabel = action === 'file' ? '📄 File' : action === 'chat' ? '💬 Chat' : '📄💬 Both';
    try {
      const targetLabel = targets.join(', ');
      await ctx.editMessageText(
        `📡 *Reddit Fetch* — ${esc(actionLabel)}\n` +
        `Target: \`${esc(targetLabel)}\` · ${output.length} chars`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch { /* ignore edit failure */ }

    // Clean up
    pendingRedditResults.delete(callbackMsgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
    pendingRedditResults.delete(callbackMsgId);
  }
}

// Pending Freedium results keyed by chatId, with 5-min TTL
const pendingMediumResults = new Map<number, { article: FreediumArticle; messageId: number; expiresAt: number }>();
const MEDIUM_RESULT_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of expired pending results to prevent memory leaks.
// .unref() so this timer doesn't prevent graceful process shutdown.
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [msgId, entry] of pendingRedditResults) {
    if (now > entry.expiresAt) pendingRedditResults.delete(msgId);
  }
  for (const [chatId, entry] of pendingMediumResults) {
    if (now > entry.expiresAt) pendingMediumResults.delete(chatId);
  }
}, REDDIT_RESULT_TTL_MS);
_cleanupInterval.unref();

/**
 * Fetch a Medium article via Freedium and present inline action buttons.
 */
export async function executeMediumFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const url = args.trim().split(/\s+/)[0];

  if (!url) {
    await replyMd(ctx, '❌ Missing URL\\. Example: `/medium https://medium.com/...`');
    return;
  }

  if (!isMediumUrl(url)) {
    await replyMd(ctx, '❌ Not a recognized Medium URL\\.\n\nSupported: medium\\.com, towardsdatascience\\.com, and other known Medium publication domains\\.');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const article = await fetchMediumArticle(url);

    // Build preview: title + author + first ~200 chars of markdown
    const preview = article.markdown.length > 200
      ? article.markdown.slice(0, 200).trimEnd() + '...'
      : article.markdown;

    const previewText =
      `📰 *${esc(article.title)}*\n` +
      `_by ${esc(article.author)}_\n\n` +
      `${esc(preview)}\n\n` +
      `_${article.markdown.length} chars — choose an action:_`;

    // Build inline keyboard based on Telegraph availability
    const inlineKeyboard = config.TELEGRAPH_ENABLED
      ? [
          [
            { text: '📄 Telegraph', callback_data: 'medium:telegraph' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '📄💾 Both', callback_data: 'medium:both' },
          ],
        ]
      : [
          [
            { text: '💬 Send to Chat', callback_data: 'medium:chat' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '💬💾 Both', callback_data: 'medium:chatboth' },
          ],
        ];

    const msg = await ctx.reply(previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    // Store result for callback handling
    pendingMediumResults.set(chatId, {
      article,
      messageId: msg.message_id,
      expiresAt: Date.now() + MEDIUM_RESULT_TTL_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Medium fetch failed: ${esc(message.substring(0, 300))}`);
  }
}

/**
 * Handle inline keyboard callbacks for Medium article actions.
 */
export async function handleMediumCallback(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('medium:')) return;

  const action = data.replace('medium:', '');

  // Look up pending result
  const pending = pendingMediumResults.get(chatId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingMediumResults.delete(chatId);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  const { article } = pending;
  await ctx.answerCallbackQuery();

  const doTelegraph = action === 'telegraph' || action === 'both';
  const doChat = action === 'chat' || action === 'chatboth';
  const doSave = action === 'save' || action === 'both' || action === 'chatboth';

  let telegraphUrl: string | null = null;
  let mdPath: string | null = null;

  try {
    if (doTelegraph) {
      telegraphUrl = await createTelegraphPage(article.title, article.markdown);
    }

    if (doSave) {
      const outputDir = ensureMediumOutputDir(ctx, article.url);
      const slug = slugFromUrl(article.url);
      mdPath = path.join(outputDir, `${slug}.md`);
      fs.writeFileSync(mdPath, article.markdown, { encoding: 'utf-8', mode: 0o600 });
    }

    // Build result message
    let resultText = `📰 *${esc(article.title)}*\n_by ${esc(article.author)}_\n\n`;

    if (telegraphUrl) {
      resultText += `📄 [Open in Instant View](${esc(telegraphUrl)})\n`;
    }
    if (doChat) {
      resultText += `💬 Sending to chat\\.\\.\\.\n`;
    }
    if (mdPath) {
      resultText += `💾 Markdown saved \\(${article.markdown.length} chars\\)`;
    }

    // Edit the original message to show results
    try {
      await ctx.editMessageText(resultText, { parse_mode: 'MarkdownV2' });
    } catch {
      // If edit fails (e.g. message too old), send new message
      await replyMd(ctx, resultText);
    }

    // Send content to chat if requested (inline messages)
    if (doChat) {
      await messageSender.sendMessage(ctx, article.markdown);
    }

    // Send .md file as document
    if (mdPath) {
      await messageSender.sendDocument(ctx, mdPath, `📎 ${path.basename(mdPath)}`);
    }

    // Clean up pending result
    pendingMediumResults.delete(chatId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
  }
}

export async function handleMedium(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📰 *Medium Fetch*\n\n` +
      `Fetch a Medium article via Freedium and convert to Markdown\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://medium.com/@user/post\\-id\`\n` +
      `• \`https://towardsdatascience.com/some\\-article\`\n\n` +
      `👇 _Paste a Medium article URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://medium.com/@user/post-id',
          selective: true,
        },
      }
    );
    return;
  }

  await executeMediumFetch(ctx, args);
}

export async function handleReddit(ctx: Context): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📡 *Reddit Fetch*\n\n` +
      `Fetch posts, subreddits, or user profiles from Reddit\\.\n\n` +
      `*Examples:*\n` +
      `• \`r/ClaudeAI \\-\\-sort new \\-\\-limit 5\`\n` +
      `• \`1lmkfhf\` \\(post ID\\)\n` +
      `• \`u/username \\-\\-limit 5\`\n` +
      `• \`r/LocalLLaMA \\-\\-sort top \\-\\-time week\`\n\n` +
      `👇 _Enter your Reddit target:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'r/ClaudeAI --sort new --limit 10',
          selective: true,
        },
      }
    );
    return;
  }

  await executeRedditFetch(ctx, args);
}

export async function handleVReddit(ctx: Context): Promise<void> {
  if (!config.VREDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit video');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `🎬 *Reddit Video*\n\n` +
      `Download a Reddit\\-hosted video from a post URL\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://www.reddit.com/r/sub/comments/abc123/title/\`\n` +
      `• \`https://www.reddit.com/r/sub/s/shareCode\`\n` +
      `• \`https://redd.it/abc123\`\n\n` +
      `👇 _Paste a Reddit post URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://www.reddit.com/r/sub/comments/abc123/',
          selective: true,
        },
      }
    );
    return;
  }

  await executeVReddit(ctx, args);
}

// ── /transcribe command ────────────────────────────────────────────

/**
 * Send a transcript as text (short) or .txt document (long).
 * Exported so voice.handler.ts can reuse it for the ForceReply path.
 */
export async function sendTranscriptResult(ctx: Context, transcript: string): Promise<void> {
  if (transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
    await messageSender.sendMessage(ctx, transcript);
  } else {
    const tmpPath = path.join(os.tmpdir(), `claudegram_transcript_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpPath, transcript, { encoding: 'utf-8', mode: 0o600 });
      const inputFile = new InputFile(fs.readFileSync(tmpPath), 'transcript.txt');
      await ctx.replyWithDocument(inputFile, {
        caption: `🎤 Transcript (${transcript.length} chars)`,
      });
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {
        console.warn(`[transcribe] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Download a Telegram file by file_id → transcribe → send result.
 * Shared helper for reply-to and ForceReply paths.
 */
async function transcribeAndSend(
  ctx: Context,
  fileId: string,
  mimeHint?: string
): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });
  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return file_path.');

    const ext = mimeHint?.includes('ogg') ? '.ogg'
      : mimeHint?.includes('mp3') ? '.mp3'
      : mimeHint?.includes('wav') ? '.wav'
      : mimeHint?.includes('mp4') ? '.m4a'
      : '.oga';
    tempFilePath = path.join(os.tmpdir(), `claudegram_transcribe_${Date.now()}${ext}`);

    await downloadTelegramAudio(config.TELEGRAM_BOT_TOKEN, file.file_path, tempFilePath);

    const buf = fs.readFileSync(tempFilePath);
    if (!buf.length) throw new Error('Downloaded empty audio file.');

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Transcribe] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn(`[Transcribe] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}

export async function handleTranscribe(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  // Path A: reply to a voice/audio/audio-document message
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const voice = (reply as { voice?: { file_id: string; mime_type?: string } }).voice;
    const audio = (reply as { audio?: { file_id: string; mime_type?: string } }).audio;
    const doc = (reply as { document?: { file_id: string; mime_type?: string } }).document;

    const fileId = voice?.file_id
      || audio?.file_id
      || (doc?.mime_type?.startsWith('audio/') ? doc.file_id : null);
    const mime = voice?.mime_type || audio?.mime_type || doc?.mime_type;

    if (fileId) {
      await transcribeAndSend(ctx, fileId, mime);
      return;
    }
  }

  // Path B: no audio attached — send ForceReply prompt
  await ctx.reply(
    '🎤 *Transcribe Audio*\n\n_Send a voice note or audio file:_',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Send a voice note or audio file',
        selective: true,
      },
    }
  );
}

/**
 * Handle audio messages (message:audio) sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeAudio(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.from?.is_bot) return;
  const replyText = (replyTo as { text?: string }).text || '';
  if (!replyText.includes('Transcribe Audio')) return;

  const audio = ctx.message?.audio;
  if (!audio) return;

  await transcribeAndSend(ctx, audio.file_id, audio.mime_type);
}

/**
 * Handle document messages with audio MIME sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeDocument(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.from?.is_bot) return;
  const replyText = (replyTo as { text?: string }).text || '';
  if (!replyText.includes('Transcribe Audio')) return;

  const doc = ctx.message?.document;
  if (!doc || !doc.mime_type?.startsWith('audio/')) return;

  await transcribeAndSend(ctx, doc.file_id, doc.mime_type);
}

// ── /extract command ───────────────────────────────────────────────

// Store pending extract URLs keyed by chatId so the callback knows what to process
const pendingExtractUrls = new Map<number, string>();

// TTLs for cleanup (in ms)
const EXTRACT_URL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROJECT_BROWSER_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Track timestamps for extract URLs and project browser
const pendingExtractTimestamps = new Map<number, number>();
const projectBrowserTimestamps = new Map<number, number>();

/**
 * Cleanup interval to prevent memory leaks from unbounded Maps.
 * Runs every 60 seconds and removes stale entries.
 */
// Interval assigned to call .unref() for graceful shutdown
const cleanupInterval = setInterval(() => {
  const now = Date.now();

  // Clean pendingMediumResults (already has expiresAt field)
  for (const [chatId, entry] of pendingMediumResults.entries()) {
    if (now > entry.expiresAt) {
      pendingMediumResults.delete(chatId);
      console.log(`[cleanup] Removed stale pendingMediumResults for chat ${chatId}`);
    }
  }

  // Clean pendingExtractUrls
  for (const [chatId, timestamp] of pendingExtractTimestamps.entries()) {
    if (now - timestamp > EXTRACT_URL_TTL_MS) {
      pendingExtractUrls.delete(chatId);
      pendingExtractTimestamps.delete(chatId);
      console.log(`[cleanup] Removed stale pendingExtractUrls for chat ${chatId}`);
    }
  }

  // Clean projectBrowserState
  for (const [chatId, timestamp] of projectBrowserTimestamps.entries()) {
    if (now - timestamp > PROJECT_BROWSER_TTL_MS) {
      projectBrowserState.delete(chatId);
      projectBrowserTimestamps.delete(chatId);
      console.log(`[cleanup] Removed stale projectBrowserState for chat ${chatId}`);
    }
  }
}, 60_000);
cleanupInterval.unref();

export async function handleExtract(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `\u{1F4E5} *Extract Media*\n\n` +
      `Extract text, audio, or video from a URL\\.\n\n` +
      `*Supported platforms:*\n` +
      `\u{25B6}\u{FE0F} YouTube\n` +
      `\u{1F4F7} Instagram\n` +
      `\u{1F3B5} TikTok\n\n` +
      `\u{1F447} _Paste a URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://youtube.com/watch?v=...',
          selective: true,
        },
      }
    );
    return;
  }

  await showExtractMenu(ctx, args);
}

export async function showExtractMenu(ctx: Context, url: string): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (!isValidUrl(url)) {
    await ctx.reply('\u{274C} Invalid URL\\. Please provide a valid link\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    await ctx.reply(
      '\u{26A0}\u{FE0F} Unsupported platform\\. Supported: YouTube, Instagram, TikTok\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const label = platformLabel(platform);

  // Store URL for callback (with timestamp for cleanup)
  pendingExtractUrls.set(chatId, url);
  pendingExtractTimestamps.set(chatId, Date.now());

  await ctx.reply(
    `\u{1F4E5} *Extract from ${esc(label)}*\n\n` +
    `\`${esc(url.length > 60 ? url.slice(0, 57) + '...' : url)}\`\n\n` +
    `What do you want?`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '\u{1F4DD} Text', callback_data: 'extract:text' },
            { text: '\u{1F3A7} Audio', callback_data: 'extract:audio' },
          ],
          [
            { text: '\u{1F3AC} Video', callback_data: 'extract:video' },
            { text: '\u{2728} All', callback_data: 'extract:all' },
          ],
        ],
      },
    }
  );
}

export async function handleExtractCallback(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data || !chatId) return;

  // Handle subtitle format selection (extract:subfmt:<format>)
  if (data.startsWith('extract:subfmt:')) {
    const subtitleFormat = data.replace('extract:subfmt:', '') as SubtitleFormat;
    if (!['text', 'srt', 'vtt'].includes(subtitleFormat)) return;

    await ctx.answerCallbackQuery();

    const url = pendingExtractUrls.get(chatId);
    if (!url) {
      await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    pendingExtractUrls.delete(chatId);
    pendingExtractTimestamps.delete(chatId);

    // Remove the subtitle format menu
    try {
      const menuMsgId = ctx.callbackQuery?.message?.message_id;
      if (menuMsgId) await ctx.api.deleteMessage(chatId, menuMsgId);
    } catch (e) {
      console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
    }

    await executeExtract(ctx, url, 'text', subtitleFormat);
    return;
  }

  const mode = data.replace('extract:', '') as ExtractMode;
  if (!['text', 'audio', 'video', 'all'].includes(mode)) return;

  await ctx.answerCallbackQuery();

  const url = pendingExtractUrls.get(chatId);
  if (!url) {
    await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  // YouTube + Text → show subtitle format submenu (keep URL pending)
  const platform = detectPlatform(url);
  if (mode === 'text' && platform === 'youtube') {
    try {
      await ctx.editMessageText(
        `\u{1F4DD} *Subtitle Format*\n\n` +
        `How would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    } catch {
      // If edit fails, send new message
      await ctx.reply(
        `\u{1F4DD} *Subtitle Format*\n\nHow would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    }
    return;
  }

  pendingExtractUrls.delete(chatId);
  pendingExtractTimestamps.delete(chatId);

  // Remove the menu message
  try {
    const menuMsgId = ctx.callbackQuery?.message?.message_id;
    if (menuMsgId) {
      await ctx.api.deleteMessage(chatId, menuMsgId);
    }
  } catch (e) {
    console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
  }

  await executeExtract(ctx, url, mode);
}

export async function executeExtract(ctx: Context, url: string, mode: ExtractMode, subtitleFormat?: SubtitleFormat): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const ackMsg = await ctx.reply('\u{1F4E5} Processing...', { parse_mode: undefined });

  const updateAck = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, text, { parse_mode: undefined });
    } catch (e) {
      // Update can fail if message was deleted or content unchanged
      console.debug('[extract] Failed to update ack message:', e instanceof Error ? e.message : e);
    }
  };

  let result: ExtractResult | null = null;

  try {
    result = await extractMedia({
      url,
      mode,
      subtitleFormat,
      onProgress: (msg) => updateAck(msg),
    });

    // Delete ack message
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[extract] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    // Send results
    const platform = platformLabel(result.platform);
    const title = result.title || 'Untitled';
    const durationStr = result.duration
      ? ` (${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')})`
      : '';

    // Header
    const header = `\u{1F4E5} *${esc(platform)}*: ${esc(title)}${esc(durationStr)}`;

    // Send video if available
    if (result.videoPath && fs.existsSync(result.videoPath)) {
      try {
        await ctx.replyWithChatAction('upload_video');
        await ctx.replyWithVideo(new InputFile(result.videoPath), {
          caption: `\u{1F3AC} ${title}${durationStr}`,
          supports_streaming: true,
        });
      } catch (videoSendErr) {
        console.warn('[extract] Failed to send video:', videoSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Video file could not be sent (may be too large).', { parse_mode: undefined });
      }
    }

    // Send audio if requested (and not already handled by video)
    if (result.audioPath && fs.existsSync(result.audioPath) && (mode === 'audio' || mode === 'all')) {
      try {
        await ctx.replyWithChatAction('upload_voice');
        await ctx.replyWithAudio(new InputFile(result.audioPath), {
          title: title,
          caption: `\u{1F3A7} ${title}${durationStr}`,
        });
      } catch (audioSendErr) {
        console.warn('[extract] Failed to send audio:', audioSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Audio file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send subtitle file (SRT/VTT) if available
    if (result.subtitlePath && result.subtitleFormat && fs.existsSync(result.subtitlePath)) {
      const ext = result.subtitleFormat; // 'srt' or 'vtt'
      const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
      const fileName = `${safeTitle}.${ext}`;
      try {
        const inputFile = new InputFile(fs.readFileSync(result.subtitlePath), fileName);
        await ctx.replyWithDocument(inputFile, {
          caption: `\u{1F4DD} ${ext.toUpperCase()} subtitles for: ${title}${durationStr}`,
        });
      } catch (subSendErr) {
        console.warn('[extract] Failed to send subtitle file:', subSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Subtitle file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send transcript (plain text from Whisper or YouTube VTT→text)
    if (result.transcript) {
      if (result.transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
        await ctx.reply(`${header}\n\n${esc(result.transcript)}`, {
          parse_mode: 'MarkdownV2',
        });
      } else {
        // Send as .txt file
        const tmpPath = path.join(os.tmpdir(), `extract_transcript_${Date.now()}.txt`);
        try {
          fs.writeFileSync(tmpPath, result.transcript, { encoding: 'utf-8', mode: 0o600 });
          const inputFile = new InputFile(fs.readFileSync(tmpPath), `${title.replace(/[^a-zA-Z0-9]/g, '_')}_transcript.txt`);
          await ctx.replyWithDocument(inputFile, {
            caption: `\u{1F4DD} Transcript (${result.transcript.length} chars)`,
          });
        } finally {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch (e) {
            console.warn(`[extract] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
          }
        }
      }
    } else if ((mode === 'text' || mode === 'all') && !result.subtitlePath) {
      // Transcript was expected but empty and no subtitle file was sent either
      await ctx.reply('\u{26A0}\u{FE0F} No speech detected in the audio.', { parse_mode: undefined });
    }

    // Show any warnings
    for (const warning of result.warnings) {
      await ctx.reply(`\u{26A0}\u{FE0F} ${warning}`, { parse_mode: undefined });
    }

    // Success summary for non-text modes when no transcript was sent
    if (mode !== 'text' && !result.transcript) {
      await ctx.reply(header, { parse_mode: 'MarkdownV2' });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[extract] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `\u{274C} ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`\u{274C} Extraction failed: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (result) {
      cleanupExtractResult(result);
    }
  }
}
