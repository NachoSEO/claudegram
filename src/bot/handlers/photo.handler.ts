import { Context } from 'grammy';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config.js';
import { sendToAgent } from '../../claude/agent.js';
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
import { escapeMarkdownV2 } from '../../telegram/markdown.js';
import { getStreamingMode } from './command.handler.js';
import { type PhotoSize } from 'grammy/types';

const UPLOADS_DIR = '.claudegram/uploads';

function esc(text: string): string {
  return escapeMarkdownV2(text);
}

function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureUploadsDir(projectDir: string): string {
  const dir = path.join(projectDir, UPLOADS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pickLargestPhoto(photoSizes: PhotoSize[]): PhotoSize {
  return photoSizes.reduce((best, current) => {
    const bestSize = best.file_size || 0;
    const currentSize = current.file_size || 0;
    return currentSize > bestSize ? current : best;
  });
}

async function downloadTelegramFile(ctx: Context, fileId: string, destPath: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram did not provide file_path for this image.');
  }

  const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  await new Promise<void>((resolve, reject) => {
    execFile(
      'curl',
      [
        '-sS',
        '-f',
        '--connect-timeout', '10',
        '--max-time', '30',
        '--retry', '2',
        '--retry-delay', '2',
        '-o', destPath,
        fileUrl,
      ],
      { timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`Failed to download image: ${msg}`));
          return;
        }
        resolve();
      }
    );
  });

  return file.file_path;
}

async function handleSavedImage(
  ctx: Context,
  savedPath: string,
  caption?: string
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = sessionManager.getSession(chatId);
  if (!session) return;

  const relativePath = path.relative(session.workingDirectory, savedPath);

  const captionText = caption?.trim();
  const noteLines = [
    'User uploaded an image to the project.',
    `Saved at: ${savedPath}`,
    `Relative path: ${relativePath}`,
    captionText ? `Caption: "${captionText}"` : 'Caption: (none)',
    'If the caption includes a question or request, answer it. Otherwise, acknowledge briefly and ask if they want any analysis or edits.',
    'You can inspect the image with tools if needed (e.g. Python + PIL).',
  ];

  const agentPrompt = noteLines.join('\n');

  if (isProcessing(chatId)) {
    const position = getQueuePosition(chatId) + 1;
    await ctx.reply(`⏳ Queued \(position ${position}\)`, { parse_mode: 'MarkdownV2' });
  }

  await queueRequest(chatId, agentPrompt, async () => {
    if (getStreamingMode() === 'streaming') {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, agentPrompt, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
        });

        await messageSender.finishStreaming(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    } else {
      await ctx.replyWithChatAction('typing');
      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      const response = await sendToAgent(chatId, agentPrompt, { abortController });
      await messageSender.sendMessage(ctx, response.text);
    }
  });
}

export async function handlePhoto(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const photos = ctx.message?.photo;

  if (!chatId || !messageId || !messageDate || !photos || photos.length === 0) return;

  if (isStaleMessage(messageDate)) {
    console.log(`[Photo] Ignoring stale photo message ${messageId}`);
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Photo] Ignoring duplicate photo message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const largest = pickLargestPhoto(photos);
  const fileSizeBytes = largest.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (fileSizeMB > config.IMAGE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Image too large \(${esc(fileSizeMB.toFixed(1))}MB\)\.
\nPlease send images under ${esc(String(config.IMAGE_MAX_FILE_SIZE_MB))}MB\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const uploadsDir = ensureUploadsDir(session.workingDirectory);
  const timestamp = Date.now();
  const fallbackName = `photo_${timestamp}_${largest.file_unique_id}.jpg`;
  const destPath = path.join(uploadsDir, fallbackName);

  try {
    const filePath = await downloadTelegramFile(ctx, largest.file_id, destPath);
    const ext = path.extname(filePath) || '.jpg';
    const finalPath = ext && ext !== '.jpg'
      ? destPath.replace(/\.jpg$/, ext)
      : destPath;

    if (finalPath !== destPath) {
      fs.renameSync(destPath, finalPath);
    }

    const buffer = fs.readFileSync(finalPath);
    if (!buffer.length) {
      throw new Error('Downloaded image is empty.');
    }

    await handleSavedImage(ctx, finalPath, ctx.message?.caption);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Photo] Error:', error);
    await ctx.reply(`❌ Image error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

export async function handleImageDocument(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const document = ctx.message?.document;

  if (!chatId || !messageId || !messageDate || !document) return;

  // Only handle image documents
  if (!document.mime_type || !document.mime_type.startsWith('image/')) {
    return;
  }

  if (isStaleMessage(messageDate)) {
    console.log(`[ImageDoc] Ignoring stale document ${messageId}`);
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[ImageDoc] Ignoring duplicate document ${messageId}`);
    return;
  }
  markProcessed(messageId);

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fileSizeBytes = document.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (fileSizeMB > config.IMAGE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Image too large \(${esc(fileSizeMB.toFixed(1))}MB\)\.
\nPlease send images under ${esc(String(config.IMAGE_MAX_FILE_SIZE_MB))}MB\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const uploadsDir = ensureUploadsDir(session.workingDirectory);
  const timestamp = Date.now();
  const originalName = document.file_name ? sanitizeFileName(document.file_name) : '';
  const ext = originalName.includes('.') ? '' : '.jpg';
  const baseName = originalName || `image_${timestamp}_${document.file_unique_id}${ext}`;
  const destPath = path.join(uploadsDir, `${timestamp}_${baseName}`);

  try {
    await downloadTelegramFile(ctx, document.file_id, destPath);

    const buffer = fs.readFileSync(destPath);
    if (!buffer.length) {
      throw new Error('Downloaded image is empty.');
    }

    await handleSavedImage(ctx, destPath, ctx.message?.caption);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ImageDoc] Error:', error);
    await ctx.reply(`❌ Image error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}
