import { Context } from 'grammy';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { transcribeFile } from '../../audio/transcribe.js';
import { sendTranscriptResult } from './command.handler.js';

function esc(text: string): string {
  return escapeMarkdownV2(text);
}

export async function handleVoice(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const voice = ctx.message?.voice;

  if (!chatId || !messageId || !messageDate || !voice) return;

  // Stale/duplicate filters
  if (isStaleMessage(messageDate)) {
    console.log(`[Voice] Ignoring stale voice message ${messageId}`);
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Voice] Ignoring duplicate voice message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // If this is a reply to the bot's "Transcribe Audio" ForceReply, route to transcribe-only flow
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.is_bot) {
    const replyText = (replyTo as { text?: string }).text || '';
    if (replyText.includes('Transcribe Audio')) {
      await handleTranscribeOnly(ctx, chatId, messageId, voice);
      return;
    }
  }

  // Check session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check file size
  const fileSizeBytes = voice.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  if (fileSizeMB > config.VOICE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Voice note too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\n\nPlease send shorter notes \\(max ${config.VOICE_MAX_FILE_SIZE_MB}MB\\)\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Acknowledge receipt
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;

  try {
    // Download voice file from Telegram (with retry for transient network errors)
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // Download using curl (more reliable than Node fetch on this network)
    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `claudegram_voice_${messageId}${ext}`);

    await new Promise<void>((resolve, reject) => {
      execFile(
        'curl',
        ['-sS', '-f', '--connect-timeout', '10', '--max-time', '30',
         '--retry', '2', '--retry-delay', '2',
         '-o', tempFilePath!,
         fileUrl],
        { timeout: 60_000 },
        (error, _stdout, stderr) => {
          if (error) {
            const msg = (stderr || '').trim() || error.message;
            console.error(`[Voice] curl download failed:`, msg);
            reject(new Error(`Failed to download voice file: ${msg}`));
          } else {
            resolve();
          }
        }
      );
    });

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    console.log(`[Voice] Downloaded ${fileSizeMB.toFixed(1)}MB to ${tempFilePath}`);

    // Transcribe using groq_transcribe.py
    const transcript = await transcribeFile(tempFilePath);

    console.log(`[Voice] Transcript (${transcript.length} chars): ${transcript.substring(0, 100)}...`);

    // Show full transcript if configured (uses smart Telegram chunking)
    if (config.VOICE_SHOW_TRANSCRIPT) {
      try {
        await ctx.api.editMessageText(
          chatId,
          ackMsg.message_id,
          '🎤 Transcript received\\.',
          { parse_mode: 'MarkdownV2' }
        );
      } catch {
        try {
          await ctx.api.deleteMessage(chatId, ackMsg.message_id);
        } catch { /* ignore */ }
      }

      await messageSender.sendMessage(ctx, `🎤 Transcript:\n\n${transcript}`);
    } else {
      // Remove ack message
      try {
        await ctx.api.deleteMessage(chatId, ackMsg.message_id);
      } catch { /* ignore */ }
    }

    // Check if already processing - show queue position
    if (isProcessing(chatId)) {
      const position = getQueuePosition(chatId) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }

    // Feed transcript into agent
    await queueRequest(chatId, transcript, async () => {
      if (getStreamingMode() === 'streaming') {
        await messageSender.startStreaming(ctx);

        const abortController = new AbortController();
        setAbortController(chatId, abortController);

        try {
          const response = await sendToAgent(chatId, transcript, {
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

        const response = await sendToAgent(chatId, transcript, { abortController });
        await messageSender.sendMessage(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Voice] Error:', error);

    // Try to update ack message with error
    try {
      await ctx.api.editMessageText(
        chatId,
        ackMsg.message_id,
        `❌ ${errorMessage}`,
        { parse_mode: undefined }
      );
    } catch {
      await ctx.reply(`❌ Voice error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Voice] Cleaned up ${tempFilePath}`);
      } catch { /* ignore */ }
    }
  }
}

/**
 * Transcribe-only flow: voice note sent as reply to "Transcribe Audio" ForceReply.
 * Does NOT send transcript to the Claude agent.
 */
async function handleTranscribeOnly(
  ctx: Context,
  chatId: number,
  messageId: number,
  voice: { file_id: string; file_size?: number; mime_type?: string }
): Promise<void> {
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `claudegram_transcribe_${messageId}${ext}`);

    await new Promise<void>((resolve, reject) => {
      execFile(
        'curl',
        ['-sS', '-f', '--connect-timeout', '10', '--max-time', '30',
         '--retry', '2', '--retry-delay', '2',
         '-o', tempFilePath!,
         fileUrl],
        { timeout: 60_000 },
        (error, _stdout, stderr) => {
          if (error) {
            const msg = (stderr || '').trim() || error.message;
            reject(new Error(`Failed to download voice file: ${msg}`));
          } else {
            resolve();
          }
        }
      );
    });

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }

    await sendTranscriptResult(ctx, transcript);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Transcribe] Voice ForceReply error:', error);
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
    }
  }
}
