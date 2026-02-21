import { Context } from 'grammy';
import { sendToAgent, sendLoopToAgent, clearConversation, type AgentUsage } from '../../providers/provider-router.js';
import { sessionManager } from '../../claude/session-manager.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
  cancelRequest,
  clearQueue,
} from '../../claude/request-queue.js';
import { isClaudeCommand } from '../../claude/command-parser.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { createTelegraphFromFile } from '../../telegram/telegraph.js';
import { getStreamingMode, executeRedditFetch, executeMediumFetch, showExtractMenu, projectStatusSuffix, resumeCommandMessage } from './command.handler.js';
import { executeVReddit } from '../../reddit/vreddit.js';
import { detectPlatform, isValidUrl } from '../../media/extract.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';

async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(`⚠️ ${feature} feature is disabled in configuration.`, { parse_mode: undefined });
}


function extractRedditUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/\S+/gi);
  if (!matches) return null;
  for (const match of matches) {
    try {
      const url = new URL(match);
      if (url.hostname === 'reddit.com' || url.hostname.endsWith('.reddit.com') || url.hostname === 'redd.it' || url.hostname === 'v.redd.it') {
        return match;
      }
    } catch {
      // ignore malformed URLs
    }
  }
  return null;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function getProgressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  const empty = 10 - filled;
  const color = clamped >= 80 ? '🔴' : clamped >= 60 ? '🟡' : '🟢';
  return color + ' [' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

async function sendUsageFooter(
  ctx: Context,
  usage: AgentUsage | undefined,
): Promise<void> {
  if (!config.CONTEXT_SHOW_USAGE || !usage) return;
  const u = usage;
  const pct = u.contextWindow > 0
    ? Math.round(((u.inputTokens + u.outputTokens + u.cacheReadTokens) / u.contextWindow) * 100)
    : 0;
  const bar = getProgressBar(pct);
  const footer = `${bar} ${pct}% context · ${fmtTokens(u.inputTokens + u.outputTokens + u.cacheReadTokens)}/${fmtTokens(u.contextWindow)} · $${u.totalCostUsd.toFixed(4)} · ${u.numTurns} turns`;
  await ctx.reply(footer, { parse_mode: undefined });
}

async function sendCompactionNotification(
  ctx: Context,
  compaction: { trigger: 'manual' | 'auto'; preTokens: number } | undefined,
): Promise<void> {
  if (!config.CONTEXT_NOTIFY_COMPACTION || !compaction) return;
  const c = compaction;
  console.log(`[Compaction] Sending notification: trigger=${c.trigger}, preTokens=${c.preTokens}`);
  const emoji = c.trigger === 'auto' ? '⚠️' : 'ℹ️';
  const triggerLabel = c.trigger === 'auto' ? 'Auto-compacted' : 'Manually compacted';
  try {
    const msg = `${emoji} *Context Compacted*\n\n`
      + `${esc(triggerLabel)} — previous context was ${esc(fmtTokens(c.preTokens))} tokens\\.\n`
      + `The agent now has a summarized version of your conversation\\.\n\n`
      + `_Tip: Use /handoff before compaction to save a detailed context document\\._`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('[Compaction] Failed to send notification:', err);
    // Fallback to plain text if MarkdownV2 fails
    try {
      await ctx.reply(
        `${emoji} Context Compacted\n\n`
        + `${triggerLabel} — previous context was ${fmtTokens(c.preTokens)} tokens.\n`
        + `The agent now has a summarized version of your conversation.`,
        { parse_mode: undefined }
      );
    } catch (fallbackErr) {
      console.error('[Compaction] Fallback notification also failed:', fallbackErr);
    }
  }
}

async function sendSessionInitNotification(
  ctx: Context,
  sessionKey: string,
  sessionInit: { model: string; sessionId: string } | undefined,
): Promise<void> {
  if (!config.CONTEXT_NOTIFY_COMPACTION || !sessionInit) return;
  const previousSessionId = sessionManager.getSession(sessionKey)?.claudeSessionId;
  if (previousSessionId && sessionInit.sessionId !== previousSessionId) {
    const msg = `🔄 *New Agent Session*\n\n`
      + `A new agent session has started \\(previous context may be summarized\\)\\.\n`
      + `Model: \`${esc(sessionInit.model)}\`\n\n`
      + `_The agent may not remember earlier details\\. Consider sharing context\\._`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  }
}

function getAutoVRedditUrl(text: string): string | null {
  if (!config.VREDDIT_ENABLED) return null;

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  const url = extractRedditUrl(trimmed);
  if (!url) return null;

  const tokens = trimmed.split(/\s+/);
  const isSolo = tokens.length === 1;
  const askedForVReddit = /\bvreddit\b|\bv\s*reddit\b/i.test(trimmed);

  return isSolo || askedForVReddit ? url : null;
}

export async function handleMessage(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const text = ctx.message?.text;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;

  if (!keyInfo || !text || !messageId || !messageDate) return;
  const { chatId, sessionKey } = keyInfo;

  // Filter stale messages (sent before bot started)
  if (isStaleMessage(messageDate)) {
    console.log(`[Message] Ignoring stale message ${messageId} from before bot start`);
    return;
  }

  // Check for duplicate messages (Telegram retries)
  if (isDuplicate(messageId)) {
    console.log(`[Message] Ignoring duplicate message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Check if this is a reply to a ForceReply prompt
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.is_bot) {
    const replyText = replyTo.text || '';

    // Handle project path reply
    if (replyText.includes('Set Project Directory')) {
      await handleProjectReply(ctx, sessionKey, text);
      return;
    }

    // Handle telegraph/instant view reply (check BEFORE file - both have "file path")
    if (replyText.includes('Instant View') || replyText.includes('Markdown files')) {
      await handleTelegraphReply(ctx, sessionKey, text);
      return;
    }

    // Handle file download reply
    if (replyText.includes('Download File')) {
      await handleFileReply(ctx, sessionKey, text);
      return;
    }

    // Handle plan mode reply
    if (replyText.includes('Plan Mode') || replyText.includes('Describe your task')) {
      await handleAgentReply(ctx, sessionKey, text, 'plan');
      return;
    }

    // Handle explore mode reply
    if (replyText.includes('Explore Mode') || replyText.includes('What would you like to know')) {
      await handleAgentReply(ctx, sessionKey, text, 'explore');
      return;
    }

    // Handle loop mode reply
    if (replyText.includes('Loop Mode') || replyText.includes('work iteratively')) {
      await handleAgentReply(ctx, sessionKey, text, 'loop');
      return;
    }

    // Handle reddit fetch reply
    if (replyText.includes('Reddit Fetch') || replyText.includes('Reddit target')) {
      if (!config.REDDIT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Reddit');
        return;
      }
      await executeRedditFetch(ctx, text.trim());
      return;
    }

    // Handle Reddit video fetch reply
    if (replyText.includes('Reddit Video')) {
      if (!config.VREDDIT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Reddit video');
        return;
      }
      await executeVReddit(ctx, text.trim());
      return;
    }

    // Handle medium fetch reply
    if (replyText.includes('Medium Fetch') || replyText.includes('Medium article')) {
      if (!config.MEDIUM_ENABLED) {
        await replyFeatureDisabled(ctx, 'Medium');
        return;
      }
      await executeMediumFetch(ctx, text.trim());
      return;
    }

    // Handle extract media reply
    if (replyText.includes('Extract Media') || replyText.includes('Paste a URL')) {
      if (!config.EXTRACT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Extract');
        return;
      }
      await showExtractMenu(ctx, text.trim());
      return;
    }
  }

  const vRedditUrl = getAutoVRedditUrl(text);
  if (vRedditUrl) {
    await executeVReddit(ctx, vRedditUrl);
    return;
  }

  // Auto-detect YouTube / TikTok / Instagram URLs sent as bare links → show extract menu
  const trimmedText = text.trim();
  if (config.EXTRACT_ENABLED && isValidUrl(trimmedText) && detectPlatform(trimmedText) !== 'unknown') {
    await showExtractMenu(ctx, trimmedText);
    return;
  }

  // Skip if this is a Claude command (handled by command handler)
  if (isClaudeCommand(text)) {
    return;
  }

  // Check for active session
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // If CANCEL_ON_NEW_MESSAGE is enabled, auto-cancel the running query;
  // otherwise queue the new message behind it and show the queue position.
  if (isProcessing(sessionKey)) {
    if (config.CANCEL_ON_NEW_MESSAGE) {
      await cancelRequest(sessionKey);
      clearQueue(sessionKey);
    } else {
      const position = getQueuePosition(sessionKey) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }
  }

  try {
    // Queue the request - process one at a time per session
    await queueRequest(sessionKey, text, async () => {
      if (getStreamingMode() === 'streaming') {
        await handleStreamingResponse(ctx, sessionKey, text);
      } else {
        await handleWaitResponse(ctx, sessionKey, chatId, text);
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error handling message:', error);
    await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to project ForceReply prompt
async function handleProjectReply(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  let resolvedPath = projectPath.trim();

  // Handle ~ expansion
  if (resolvedPath.startsWith('~')) {
    resolvedPath = path.join(process.env.HOME || '', resolvedPath.slice(1));
  }

  // Resolve to absolute path
  resolvedPath = path.resolve(resolvedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, resolvedPath)) {
    await ctx.reply(
      `❌ Path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check if exists
  if (!fs.existsSync(resolvedPath)) {
    await ctx.reply(
      `❌ Path not found: \`${esc(resolvedPath)}\`\n\nPlease check the path and try again\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check if directory
  if (!fs.statSync(resolvedPath).isDirectory()) {
    await ctx.reply(
      `❌ Not a directory: \`${esc(resolvedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Set the project
  sessionManager.setWorkingDirectory(sessionKey, resolvedPath);
  clearConversation(sessionKey);

  const projectName = path.basename(resolvedPath);
  await ctx.reply(
    `✅ Project set: *${esc(projectName)}*\n\n\`${esc(resolvedPath)}\`\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`,
    { parse_mode: 'MarkdownV2' }
  );

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await ctx.reply(resumeCommandMessage(s.claudeSessionId), { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to file ForceReply prompt
async function handleFileReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const trimmedPath = filePath.trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await ctx.reply(
      `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await ctx.reply(
      `❌ File not found: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await ctx.reply(
      `❌ That's a directory, not a file: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await ctx.reply(
      '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// Handle reply to plan/explore/loop ForceReply prompts
async function handleAgentReply(
  ctx: Context,
  sessionKey: string,
  input: string,
  mode: 'plan' | 'explore' | 'loop'
): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const trimmedInput = input.trim();
  if (!trimmedInput) {
    await ctx.reply(
      '❌ Please provide a description\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, trimmedInput, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        let response;
        if (mode === 'loop') {
          response = await sendLoopToAgent(sessionKey, trimmedInput, {
            onProgress: (progressText) => {
              messageSender.updateStream(ctx, progressText);
            },
            abortController,
            telegramCtx: ctx,
          });
        } else {
          response = await sendToAgent(sessionKey, trimmedInput, {
            onProgress: (progressText) => {
              messageSender.updateStream(ctx, progressText);
            },
            onToolStart: (toolName, input) => {
              messageSender.updateToolOperation(sessionKey, toolName, input, ctx);
            },
            onToolEnd: () => {
              messageSender.clearToolOperation(sessionKey);
            },
            abortController,
            command: mode,
            telegramCtx: ctx,
          });
        }

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);

        // Context visibility notifications
        await sendUsageFooter(ctx, response.usage);
        await sendCompactionNotification(ctx, response.compaction);
        await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to telegraph ForceReply prompt
async function handleTelegraphReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const trimmedPath = filePath.trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await ctx.reply(
      `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await ctx.reply(
      `❌ File not found: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await ctx.reply(
      `❌ That's a directory, not a file: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await ctx.reply(
      '⚠️ Telegraph works best with Markdown files \\(\\.md\\)',
      { parse_mode: 'MarkdownV2' }
    );
  }

  await ctx.reply('📤 Creating Telegraph page\\.\\.\\.', { parse_mode: 'MarkdownV2' });

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await ctx.reply(
      `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`,
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.reply(
      '❌ Failed to create Telegraph page\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function handleStreamingResponse(
  ctx: Context,
  sessionKey: string,
  message: string
): Promise<void> {
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController);

  try {
    const response = await sendToAgent(sessionKey, message, {
      onProgress: (progressText) => {
        messageSender.updateStream(ctx, progressText);
      },
      onToolStart: (toolName, input) => {
        messageSender.updateToolOperation(sessionKey, toolName, input, ctx);
      },
      onToolEnd: () => {
        messageSender.clearToolOperation(sessionKey);
      },
      abortController,
      telegramCtx: ctx,
    });

    await messageSender.finishStreaming(ctx, response.text);
    await maybeSendVoiceReply(ctx, response.text);

    // Context visibility notifications
    await sendUsageFooter(ctx, response.usage);
    await sendCompactionNotification(ctx, response.compaction);
    await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);
  } catch (error) {
    await messageSender.cancelStreaming(ctx);
    throw error;
  }
}

async function handleWaitResponse(
  ctx: Context,
  sessionKey: string,
  chatId: number,
  message: string
): Promise<void> {
  // Start continuous typing indicator (every 4s)
  const keyInfo = getSessionKeyFromCtx(ctx);
  const typingInterval = messageSender.startTypingIndicator(ctx.api, chatId, keyInfo?.threadId);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController);

  try {
    const response = await sendToAgent(sessionKey, message, { abortController, telegramCtx: ctx });
    messageSender.stopTypingInterval(typingInterval);

    await messageSender.sendMessage(ctx, response.text);
    await maybeSendVoiceReply(ctx, response.text);

    // Context visibility notifications
    await sendUsageFooter(ctx, response.usage);
    await sendCompactionNotification(ctx, response.compaction);
    await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);
  } catch (error) {
    messageSender.stopTypingInterval(typingInterval);
    throw error;
  }
}
