import {
  Message,
  Attachment,
  ChannelType,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { isAuthorizedMessage } from '../middleware/auth.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { config } from '../../config.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { downloadFileSecure } from '../../utils/download.js';
import { isValidImageFile, getFileType } from '../../utils/file-type.js';
import { handleVoiceMessage } from './voice.handler.js';
import { maybeSendDiscordVoiceReply } from '../voice-reply.js';
import { sendCompactionNotice, sendSessionInitNotice } from '../compaction-notice.js';
import { transcribeFile } from '../../audio/transcribe.js';
import * as os from 'os';

const UPLOADS_DIR = '.claudegram/uploads';

interface ReplyContext {
  /** Full prompt context to send to the agent. */
  prompt: string;
  /** Raw audio transcript (if the referenced message had audio). Null for text-only replies. */
  audioTranscript: string | null;
}

/**
 * If the message is a reply, fetch the referenced message and build context.
 * Handles: text content, audio attachments (transcribe), image attachments (save + reference).
 */
async function buildReplyContext(message: Message): Promise<ReplyContext | null> {
  if (!message.reference?.messageId) return null;

  let refMsg: Message;
  try {
    refMsg = await message.channel.messages.fetch(message.reference.messageId);
  } catch {
    return null;
  }

  const parts: string[] = [];
  let audioTranscript: string | null = null;

  // Text content from referenced message
  if (refMsg.content) {
    parts.push(`[Replied-to message from ${refMsg.author.displayName}]:\n${refMsg.content}`);
  }

  // Audio attachment on referenced message → transcribe
  const audioAttachment = refMsg.attachments.find(
    (a: Attachment) => a.contentType?.startsWith('audio/')
  );
  if (audioAttachment && config.GROQ_API_KEY) {
    try {
      const ext = audioAttachment.contentType?.includes('ogg') ? '.ogg'
        : audioAttachment.contentType?.includes('webm') ? '.webm'
        : audioAttachment.contentType?.includes('mp4') ? '.mp4'
        : '.ogg';
      const tempPath = path.join(os.tmpdir(), `claudegram_reply_audio_${refMsg.id}${ext}`);
      const resp = await fetch(audioAttachment.url);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        fs.writeFileSync(tempPath, Buffer.from(buf));
        audioTranscript = await transcribeFile(tempPath);
        parts.push(`[Transcription of replied-to audio from ${refMsg.author.displayName}]:\n${audioTranscript}`);
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error('[Discord] Failed to transcribe reply audio:', err);
    }
  }

  // Image attachment on referenced message → note it
  const imageAttachment = refMsg.attachments.find(
    (a: Attachment) => a.contentType?.startsWith('image/')
  );
  if (imageAttachment) {
    parts.push(`[Replied-to message has an image: ${imageAttachment.name || 'image'} (${imageAttachment.url})]`);
  }

  if (parts.length === 0) return null;
  return { prompt: parts.join('\n\n'), audioTranscript };
}

async function handleImageAttachment(
  message: Message,
  imageAttachment: Attachment,
  isThread: boolean,
  isMentioned: boolean,
): Promise<void> {
  const chatId = discordChatId(message.author.id);
  const channelId = message.channelId;

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await message.reply('No project set. Use `/project <path>` first.');
    return;
  }

  // Size check
  const fileSizeMB = (imageAttachment.size || 0) / (1024 * 1024);
  if (fileSizeMB > config.IMAGE_MAX_FILE_SIZE_MB) {
    await message.reply(`Image too large (${fileSizeMB.toFixed(1)}MB). Max: ${config.IMAGE_MAX_FILE_SIZE_MB}MB.`);
    return;
  }

  // Prepare upload directory
  const uploadsDir = path.join(session.workingDirectory, UPLOADS_DIR);
  fs.mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const originalName = imageAttachment.name || `image_${timestamp}.jpg`;
  const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(uploadsDir, `${timestamp}_${safeName}`);

  try {
    // Download from Discord CDN
    await downloadFileSecure(imageAttachment.url, destPath);

    // Validate magic bytes
    if (!isValidImageFile(destPath)) {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      throw new Error('Downloaded file is not a valid image.');
    }

    // Fix extension based on actual file type
    const actualType = getFileType(destPath);
    const rawExt = actualType?.extension || path.extname(originalName) || '.jpg';
    const ext = rawExt.startsWith('.') ? rawExt : `.${rawExt}`;
    const currentExt = path.extname(destPath);
    let finalPath = destPath;
    if (ext !== currentExt) {
      finalPath = destPath.replace(new RegExp(`${currentExt.replace('.', '\\.')}$`), ext);
      fs.renameSync(destPath, finalPath);
    }

    const relativePath = path.relative(session.workingDirectory, finalPath);

    // Strip mention from caption text
    let captionText = message.content;
    if (isMentioned && message.client.user) {
      captionText = captionText.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
    }

    const noteLines = [
      'User uploaded an image to the project.',
      `Saved at: ${finalPath}`,
      `Relative path: ${relativePath}`,
      captionText ? `Caption: "${captionText}"` : 'Caption: (none)',
      'If the caption includes a question or request, answer it. Otherwise, acknowledge briefly and ask if they want any analysis or edits.',
      'You can inspect the image with tools if needed (e.g. Read tool for image files).',
    ];
    const agentPrompt = noteLines.join('\n');

    if (isProcessing(chatId)) {
      const position = getQueuePosition(chatId) + 1;
      await message.reply(`Queued (position ${position})`);
    }

    try {
      await message.react('\u23F3');
    } catch { /* ignore */ }

    await queueRequest(chatId, agentPrompt, async () => {
      if (isThread && !isMentioned) {
        await discordMessageSender.startStreamingInChannel(message.channel as any, channelId);
      } else {
        await discordMessageSender.startStreamingFromMessage(message, channelId);
      }

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, agentPrompt, {
          onProgress: (progressText) => {
            discordMessageSender.updateStream(channelId, progressText);
          },
          onToolStart: (toolName, input) => {
            discordMessageSender.updateToolOperation(channelId, toolName, input);
          },
          onToolEnd: () => {
            discordMessageSender.clearToolOperation(channelId);
          },
          abortController,
          platform: 'discord',
        });

        await discordMessageSender.finishStreaming(channelId, response.text);
        await maybeSendDiscordVoiceReply(message, response.text);
        await sendCompactionNotice(message.channel, response.compaction);
        await sendSessionInitNotice(message.channel, chatId, response.sessionInit);

        try {
          await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user!.id);
        } catch { /* ignore */ }
      } catch (error) {
        await discordMessageSender.cancelStreaming(channelId);
        try {
          await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user!.id);
        } catch { /* ignore */ }
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    console.error('[Discord] Image error:', error);
    await message.reply(`Image error: ${sanitizeError(error)}`).catch(() => {});
  }
}

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const isMentioned = message.client.user ? message.mentions.has(message.client.user) : false;
  const isThread =
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread;

  // Only respond to @mentions or thread messages
  if (!isMentioned && !isThread) return;

  // Auth check
  if (!isAuthorizedMessage(message)) {
    await message.reply('You are not authorized to use this bot.');
    return;
  }

  // Voice message detection — audio attachment with duration (Discord voice messages)
  const voiceAttachment = message.attachments.find(
    (a: Attachment) => a.contentType?.startsWith('audio/') && a.duration != null
  );
  if (voiceAttachment) {
    await handleVoiceMessage(message, voiceAttachment, isThread, isMentioned);
    return;
  }

  // Image attachment detection — any image/* content type
  const imageAttachment = message.attachments.find(
    (a: Attachment) => a.contentType?.startsWith('image/')
  );
  if (imageAttachment) {
    await handleImageAttachment(message, imageAttachment, isThread, isMentioned);
    return;
  }

  // Strip the mention from the text
  let text = message.content;
  if (isMentioned && message.client.user) {
    text = text.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
  }

  // Build context from replied-to message (text, audio transcription, image refs)
  const replyContext = await buildReplyContext(message);
  if (replyContext) {
    // Show full audio transcript, chunked to fit Discord's 2000-char limit
    if (replyContext.audioTranscript) {
      const CHUNK_LIMIT = 1990;
      const transcript = replyContext.audioTranscript;
      await message.reply(`👤 ${transcript.slice(0, CHUNK_LIMIT)}`).catch(() => {});
      for (let i = CHUNK_LIMIT; i < transcript.length; i += CHUNK_LIMIT) {
        if ('send' in message.channel) {
          await (message.channel as { send: Function }).send(`👤 ${transcript.slice(i, i + CHUNK_LIMIT)}`).catch(() => {});
        }
      }
    }

    text = text
      ? `${replyContext.prompt}\n\n[User's message]: ${text}`
      : replyContext.prompt;
  }

  if (!text || text.trim().length === 0) return;

  // Session key uses the user's ID, not the channel ID
  const chatId = discordChatId(message.author.id);
  // Channel ID is used for message sending/streaming
  const channelId = message.channelId;

  // Check for active session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await message.reply('No project set. Use `/project <path>` first.');
    return;
  }

  // Show queue position if already processing
  if (isProcessing(chatId)) {
    const position = getQueuePosition(chatId) + 1;
    await message.reply(`Queued (position ${position})`);
  }

  // React with hourglass to indicate processing
  try {
    await message.react('\u23F3');
  } catch { /* ignore reaction errors */ }

  try {
    await queueRequest(chatId, text, async () => {
      // In a thread without @mention: regular message (no inline reply)
      // Otherwise (@mention or channel message): inline reply
      if (isThread && !isMentioned) {
        await discordMessageSender.startStreamingInChannel(message.channel as any, channelId);
      } else {
        await discordMessageSender.startStreamingFromMessage(message, channelId);
      }

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, text, {
          onProgress: (progressText) => {
            discordMessageSender.updateStream(channelId, progressText);
          },
          onToolStart: (toolName, input) => {
            discordMessageSender.updateToolOperation(channelId, toolName, input);
          },
          onToolEnd: () => {
            discordMessageSender.clearToolOperation(channelId);
          },
          abortController,
          platform: 'discord',
        });

        await discordMessageSender.finishStreaming(channelId, response.text);
        await maybeSendDiscordVoiceReply(message, response.text);

        // Context visibility notifications
        await sendCompactionNotice(message.channel, response.compaction);
        await sendSessionInitNotice(message.channel, chatId, response.sessionInit);

        // Remove hourglass on completion
        try {
          await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user!.id);
        } catch { /* ignore reaction errors */ }
      } catch (error) {
        await discordMessageSender.cancelStreaming(channelId);

        // Remove hourglass on error
        try {
          await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user!.id);
        } catch { /* ignore reaction errors */ }

        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    console.error('[Discord] Message error:', error);
    await message.reply(`Error: ${sanitizeError(error)}`).catch(() => {});
  }
}
