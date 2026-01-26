import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import {
  clearConversation,
  sendToAgent,
  sendLoopToAgent,
  setModel,
  getModel,
  isDangerousMode,
} from '../../claude/agent.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import {
  cancelRequest,
  clearQueue,
  isProcessing,
  queueRequest,
  setAbortController,
} from '../../claude/request-queue.js';
import { createTelegraphFromFile } from '../../telegram/telegraph.js';
import { escapeMarkdownV2 } from '../../telegram/markdown.js';
import { getTTSSettings, setTTSEnabled, setTTSVoice } from '../../tts/tts-settings.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

// Helper for consistent MarkdownV2 replies
async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

// Escape dynamic text for MarkdownV2
function esc(text: string): string {
  return escapeMarkdownV2(text);
}

const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral',
  'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

type TTSMenuMode = 'main' | 'voices';

function buildTTSMenu(chatId: number, mode: TTSMenuMode) {
  const settings = getTTSSettings(chatId);
  const apiStatus = config.OPENAI_API_KEY ? 'configured' : 'missing';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const header = `🔊 *Voice Replies*`;
  const baseText =
    `${header}\n\n` +
    `Status: *${statusLine}*\n` +
    `Voice: *${esc(settings.voice)}*\n` +
    `API key: *${esc(apiStatus)}*`;

  if (mode === 'voices') {
    const voiceRows: { text: string; callback_data: string }[][] = [];
    const chunkSize = 4;
    for (let i = 0; i < TTS_VOICES.length; i += chunkSize) {
      const chunk = TTS_VOICES.slice(i, i + chunkSize);
      voiceRows.push(chunk.map((voice) => ({
        text: voice === settings.voice ? `✓ ${voice}` : voice,
        callback_data: `tts:voice:${voice}`,
      })));
    }

    return {
      text:
        `${header}\n\n` +
        `Pick a voice\\.\nRecommended: marin, cedar\\.`,
      keyboard: [
        ...voiceRows,
        [{ text: 'Back', callback_data: 'tts:back' }],
      ],
    };
  }

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'tts:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'tts:off' },
      ],
      [{ text: `Voice: ${settings.voice}`, callback_data: 'tts:voices' }],
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

export async function handleProject(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  // No args - prompt for input with ForceReply
  if (!args) {
    const session = sessionManager.getSession(chatId);
    const currentInfo = session
      ? `\n\n_Current: ${esc(path.basename(session.workingDirectory))}_`
      : '';

    const projects = listProjects();
    const projectList = projects.length > 0
      ? `\n\n*Available:*\n${projects.slice(0, 10).map(p => `• \`${esc(p)}\``).join('\n')}`
      : '';

    await ctx.reply(
      `📁 *Set Project Directory*${currentInfo}${projectList}\n\n👇 _Enter the path below:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: '/home/user/projects/myapp',
          selective: true,
        },
      }
    );
    return;
  }

  let projectPath: string;
  if (args.startsWith('/') || args.startsWith('~')) {
    projectPath = args;
    if (projectPath.startsWith('~')) {
      projectPath = path.join(process.env.HOME || '', projectPath.slice(1));
    }
    projectPath = path.resolve(projectPath);
  } else {
    projectPath = path.join(config.WORKSPACE_DIR, args);
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

  await replyMd(ctx, `✅ Project: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!`);
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

  fs.mkdirSync(projectPath, { recursive: true });
  sessionManager.setWorkingDirectory(chatId, projectPath);
  clearConversation(chatId);

  await replyMd(ctx, `✅ Created and opened: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!`);
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

  const status = `📊 *Session Status*

• *Working Directory:* \`${esc(session.workingDirectory)}\`
• *Session ID:* \`${esc(session.conversationId)}\`
• *Model:* ${esc(currentModel)}
• *Created:* ${esc(session.createdAt.toLocaleString())}
• *Last Activity:* ${esc(session.lastActivity.toLocaleString())}
• *Mode:* ${config.STREAMING_MODE}
• *Dangerous Mode:* ${dangerousMode}
• *Uptime:* ${esc(getUptimeFormatted())}`;

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
    setTTSEnabled(chatId, true);
  } else if (data === 'tts:off') {
    setTTSEnabled(chatId, false);
  } else if (data.startsWith('tts:voice:')) {
    const voice = data.replace('tts:voice:', '');
    if (TTS_VOICES.includes(voice as typeof TTS_VOICES[number])) {
      setTTSVoice(chatId, voice);
    }
  }

  const mode: TTSMenuMode = data === 'tts:voices' || data.startsWith('tts:voice:')
    ? 'voices'
    : 'main';
  const menu = buildTTSMenu(chatId, mode);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(menu.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await replyMd(ctx, `🏓 Pong\\!\n\nUptime: ${esc(uptime)}`);
}

export async function handleCancel(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const wasProcessing = isProcessing(chatId);
  const cancelled = cancelRequest(chatId);
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
      `🤖 *Select Model*\n\n_Current: ${esc(currentModel)}_\n\n• *sonnet* \\- Balanced \\(default\\)\n• *opus* \\- Most capable\n• *haiku* \\- Fast & light`,
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
    await replyMd(ctx, '⚠️ No project set\\.\n\nUse `/project` to open a project first\\.');
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
    await replyMd(ctx, '⚠️ No project set\\.\n\nUse `/project` to open a project first\\.');
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

  const history = sessionManager.getSessionHistory(chatId, 5);

  if (history.length === 0) {
    await replyMd(ctx, 'ℹ️ No session history found\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  const keyboard = history.map((entry) => {
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
    `Working directory: \`${esc(session.workingDirectory)}\``,
    { parse_mode: 'MarkdownV2' }
  );
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
    `Working directory: \`${esc(session.workingDirectory)}\``
  );
}

export async function handleLoop(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nUse `/project` to open a project first\\.');
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
    await replyMd(ctx, '⚠️ No project set\\. Use `/project <path>` first\\.');
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

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\. Use `/project <path>` first\\.');
    return;
  }

  if (!filePath) {
    // List markdown files in the project
    const mdFiles = listMarkdownFiles(session.workingDirectory);
    const fileList = mdFiles.length > 0
      ? `\n\n*Markdown files:*\n${mdFiles.slice(0, 10).map(f => `• \`${esc(f)}\``).join('\n')}`
      : '\n\n_No markdown files found in project_';

    await ctx.reply(
      `📄 *Instant View*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_${fileList}\n\n👇 _Enter the file path:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'README.md',
          selective: true,
        },
      }
    );
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);

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
      cleanTokens.push(token, tokens[i + 1]);
      i++;
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
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildRedditOutputPath(ctx: Context, tokens: string[]): string {
  const dir = ensureRedditOutputDir(ctx);
  const raw = tokens[0] || 'reddit';
  const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'reddit';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `reddit_${slug}_${stamp}.json`);
}

async function runRedditFetch(
  ctx: Context,
  scriptPath: string,
  tokens: string[]
): Promise<{ stdout: string; stderr: string }> {
  const scriptDir = path.dirname(scriptPath);

  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [scriptPath, ...tokens],
      {
        timeout: config.REDDITFETCH_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        cwd: scriptDir,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({ error, stdout: stdout || '', stderr: stderr || '' });
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

/**
 * Execute redditfetch.py and send the result to the user.
 * Exported so message.handler.ts can reuse it for ForceReply flow.
 */
export async function executeRedditFetch(
  ctx: Context,
  args: string
): Promise<void> {
  await ctx.replyWithChatAction('typing');

  const tokens = tokenizeArgs(args);
  const { cleanTokens, format, hadOutputFlag } = parseRedditArgs(tokens);

  // Inject default --limit if not provided
  if (!cleanTokens.includes('--limit') && !cleanTokens.includes('-l')) {
    cleanTokens.push('--limit', String(config.REDDITFETCH_DEFAULT_LIMIT));
  }

  // Inject default --depth if not provided
  if (!cleanTokens.includes('--depth')) {
    cleanTokens.push('--depth', String(config.REDDITFETCH_DEFAULT_DEPTH));
  }

  const scriptPath = config.REDDITFETCH_PATH;
  try {
    const { stdout, stderr } = await runRedditFetch(ctx, scriptPath, cleanTokens);
    const output = stdout.trim();

    if (!output) {
      const hint = (stderr || '').trim();
      const errorInfo = hint ? `\n\n_${esc(hint.substring(0, 200))}_` : '';
      await replyMd(ctx, `❌ No results returned\\.${errorInfo}`);
      return;
    }

    if (!format && output.length > config.REDDITFETCH_JSON_THRESHOLD_CHARS) {
      const outputPath = buildRedditOutputPath(ctx, cleanTokens);
      const jsonTokens = [...cleanTokens, '--format', 'json', '--output', outputPath];

      try {
        await runRedditFetch(ctx, scriptPath, jsonTokens);

        const sent = await messageSender.sendDocument(
          ctx,
          outputPath,
          `📎 Reddit JSON saved: ${path.basename(outputPath)}`
        );

        const notice = sent
          ? `Large thread detected \\(${output.length} chars\\) — sent JSON file for structured review\\.`
          : `Large thread detected \\(${output.length} chars\\) — JSON saved at \`${esc(outputPath)}\`\\.`;

        await replyMd(ctx, notice);
      } catch (jsonError) {
        console.error('[Reddit] JSON fallback failed:', jsonError);
        await messageSender.sendMessage(ctx, output);
      }

      return;
    }

    await messageSender.sendMessage(ctx, output);

    if (hadOutputFlag) {
      await replyMd(ctx, 'ℹ️ Note: `-o/--output` is ignored in chat mode\\. I can save JSON automatically for large threads\\.');
    }
  } catch (err: unknown) {
    const error = err as { error?: Error; stderr?: string };
    const stderrText = (error?.stderr || '').trim();
    let userMessage: string;

    if (stderrText.includes('Missing credentials') || stderrText.includes('REDDIT_CLIENT_ID')) {
      userMessage = '❌ Reddit credentials not configured\\.\n\nSet `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` in the redditfetch \\.env file\\.';
    } else if (stderrText.includes('ModuleNotFoundError')) {
      const modMatch = stderrText.match(/No module named '(\w+)'/);
      const modName = modMatch ? modMatch[1] : 'unknown';
      userMessage = `❌ Missing Python dependency: \`${esc(modName)}\`\n\nRun: \`pip install ${esc(modName)}\``;
    } else if (error?.error && (error.error as { killed?: boolean }).killed) {
      userMessage = '❌ Reddit fetch timed out\\.';
    } else {
      const detail = stderrText || (error?.error?.message || 'Unknown error');
      userMessage = `❌ Reddit fetch failed: ${esc(detail.substring(0, 300))}`;
    }

    await replyMd(ctx, userMessage);
  }
}

export async function handleReddit(ctx: Context): Promise<void> {
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
