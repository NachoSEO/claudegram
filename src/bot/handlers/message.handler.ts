import { Context } from 'grammy';
import { sendToAgent, sendLoopToAgent, clearConversation } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { isClaudeCommand } from '../../claude/command-parser.js';
import { escapeMarkdownV2 } from '../../telegram/markdown.js';
import { createTelegraphFromFile } from '../../telegram/telegraph.js';
import { getStreamingMode, executeRedditFetch } from './command.handler.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import * as fs from 'fs';
import * as path from 'path';

// Helper for MarkdownV2
function esc(text: string): string {
  return escapeMarkdownV2(text);
}

export async function handleMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;

  if (!chatId || !text || !messageId || !messageDate) return;

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
      await handleProjectReply(ctx, chatId, text);
      return;
    }

    // Handle telegraph/instant view reply (check BEFORE file - both have "file path")
    if (replyText.includes('Instant View') || replyText.includes('Markdown files')) {
      await handleTelegraphReply(ctx, chatId, text);
      return;
    }

    // Handle file download reply
    if (replyText.includes('Download File')) {
      await handleFileReply(ctx, chatId, text);
      return;
    }

    // Handle plan mode reply
    if (replyText.includes('Plan Mode') || replyText.includes('Describe your task')) {
      await handleAgentReply(ctx, chatId, text, 'plan');
      return;
    }

    // Handle explore mode reply
    if (replyText.includes('Explore Mode') || replyText.includes('What would you like to know')) {
      await handleAgentReply(ctx, chatId, text, 'explore');
      return;
    }

    // Handle loop mode reply
    if (replyText.includes('Loop Mode') || replyText.includes('work iteratively')) {
      await handleAgentReply(ctx, chatId, text, 'loop');
      return;
    }

    // Handle reddit fetch reply
    if (replyText.includes('Reddit Fetch') || replyText.includes('Reddit target')) {
      await executeRedditFetch(ctx, text.trim());
      return;
    }
  }

  // Skip if this is a Claude command (handled by command handler)
  if (isClaudeCommand(text)) {
    return;
  }

  // Check for active session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nUse `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check if already processing - show queue position
  if (isProcessing(chatId)) {
    const position = getQueuePosition(chatId) + 1;
    await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
  }

  try {
    // Queue the request - process one at a time per chat
    await queueRequest(chatId, text, async () => {
      if (getStreamingMode() === 'streaming') {
        await handleStreamingResponse(ctx, chatId, text);
      } else {
        await handleWaitResponse(ctx, chatId, text);
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
async function handleProjectReply(ctx: Context, chatId: number, projectPath: string): Promise<void> {
  let resolvedPath = projectPath.trim();

  // Handle ~ expansion
  if (resolvedPath.startsWith('~')) {
    resolvedPath = path.join(process.env.HOME || '', resolvedPath.slice(1));
  }

  // Resolve to absolute path
  resolvedPath = path.resolve(resolvedPath);

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
  sessionManager.setWorkingDirectory(chatId, resolvedPath);
  clearConversation(chatId);

  const projectName = path.basename(resolvedPath);
  await ctx.reply(
    `✅ Project set: *${esc(projectName)}*\n\n\`${esc(resolvedPath)}\`\n\nYou can now chat with Claude about this project\\!`,
    { parse_mode: 'MarkdownV2' }
  );
}

// Handle reply to file ForceReply prompt
async function handleFileReply(ctx: Context, chatId: number, filePath: string): Promise<void> {
  const trimmedPath = filePath.trim();

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\. Use `/project` first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);

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
  chatId: number,
  input: string,
  mode: 'plan' | 'explore' | 'loop'
): Promise<void> {
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\. Use `/project` first\\.',
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
    await queueRequest(chatId, trimmedInput, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        let response;
        if (mode === 'loop') {
          response = await sendLoopToAgent(chatId, trimmedInput, {
            onProgress: (progressText) => {
              messageSender.updateStream(ctx, progressText);
            },
            abortController,
          });
        } else {
          response = await sendToAgent(chatId, trimmedInput, {
            onProgress: (progressText) => {
              messageSender.updateStream(ctx, progressText);
            },
            abortController,
            command: mode,
          });
        }

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
    await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to telegraph ForceReply prompt
async function handleTelegraphReply(ctx: Context, chatId: number, filePath: string): Promise<void> {
  const trimmedPath = filePath.trim();

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\. Use `/project` first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);

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
  chatId: number,
  message: string
): Promise<void> {
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(chatId, abortController);

  try {
    const response = await sendToAgent(chatId, message, {
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
}

async function handleWaitResponse(
  ctx: Context,
  chatId: number,
  message: string
): Promise<void> {
  // Send typing indicator
  await ctx.replyWithChatAction('typing');

  const abortController = new AbortController();
  setAbortController(chatId, abortController);

  const response = await sendToAgent(chatId, message, { abortController });
  await messageSender.sendMessage(ctx, response.text);
  await maybeSendVoiceReply(ctx, response.text);
}
