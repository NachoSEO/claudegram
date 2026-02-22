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
import { user as userItem } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import { fileToBase64 } from '../../utils/base64.js';

const UPLOADS_DIR = '.claudegram/uploads';

interface ReplyContext {
  /** Full prompt context to send to the agent. */
  prompt: string;
  /** Raw audio transcript (if the referenced message had audio). Null for text-only replies. */
  audioTranscript: string | null;
}

/**
 * Constructs a contextual prompt from the message that this message replies to.
 *
 * Builds a prompt including the replied-to message's text, a transcription if the replied-to message has an audio attachment (when transcription is available), and a note for image attachments.
 *
 * @param message - The Discord message that may reference another message
 * @returns A ReplyContext containing `prompt` (combined referenced content and notes) and `audioTranscript` (the transcription string or `null`), or `null` if there is no referenced message or no usable referenced content
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
      const resp = await fetch(audioAttachment.url, { signal: AbortSignal.timeout(30_000) });
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

/**
 * Process an image attachment from a Discord message: validate and save it to the session workspace, build an agent prompt describing the upload, enqueue processing, and stream the agent's response back to Discord.
 *
 * This uploads the image into the current session's uploads directory, checks size and file type, corrects the file extension, constructs a prompt that includes the saved path and optional caption, queues the request for the agent, shows queue/processing state (hourglass reaction and queued position), streams progress and tool activity to the channel, and on completion sends the assistant response (optionally as a voice reply) and notices. Errors are sanitized and reported to the user.
 *
 * @param message - The original Discord message containing the attachment
 * @param imageAttachment - The image attachment to validate and handle
 * @param isThread - True when the message is posted inside a thread
 * @param isMentioned - True when the bot was explicitly mentioned in the message
 */
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
      finalPath = destPath.slice(0, -currentExt.length) + ext;
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

    const imageBase64 = fileToBase64(finalPath);
    const mediaType = (actualType?.mimeType || (ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'));
    const dataUrl = `data:${mediaType};base64,${imageBase64}`;

    const agentItems: AgentInputItem[] = [
      userItem([
        { type: 'input_text', text: agentPrompt },
        { type: 'input_image', image: dataUrl },
      ]),
    ];

    if (isProcessing(chatId)) {
      const position = getQueuePosition(chatId) + 1;
      await message.reply(`Queued (position ${position})`);
    }

    try {
      await message.react('\u23F3');
    } catch { /* ignore */ }

    const previousSessionId = sessionManager.getSession(chatId)?.claudeSessionId;
    await queueRequest(chatId, agentPrompt, async () => {
      if (isThread && !isMentioned) {
        await discordMessageSender.startStreamingInChannel(message.channel as any, channelId);
      } else {
        await discordMessageSender.startStreamingFromMessage(message, channelId);
      }

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, agentItems as any, {
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
        if ('send' in message.channel) {
          await sendCompactionNotice(message.channel, response.compaction);
          await sendSessionInitNotice(message.channel, response.sessionInit, previousSessionId);
        }

        try {
          if (message.client.user) await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user.id);
        } catch { /* ignore */ }
      } catch (error) {
        await discordMessageSender.cancelStreaming(channelId);
        try {
          if (message.client.user) await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user.id);
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

/**
 * Process an incoming Discord message directed at the bot and produce an agent response.
 *
 * Handles mention/thread gating and ignores bot messages; enforces authorization; routes
 * voice and image attachments to their respective handlers; builds context from replied-to
 * messages (including optional audio transcription and image references); validates that a
 * project/session exists; manages queue position and an hourglass reaction; submits the
 * request to the agent queue; streams progress and final assistant output back to Discord;
 * optionally sends a voice reply and visibility notices; and surfaces a sanitized error
 * message on failure.
 *
 * @param message - The Discord message to process
 */
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
          await message.channel.send(`👤 ${transcript.slice(i, i + CHUNK_LIMIT)}`).catch(() => {});
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

  const previousSessionId = sessionManager.getSession(chatId)?.claudeSessionId;
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
        if ('send' in message.channel) {
          await sendCompactionNotice(message.channel, response.compaction);
          await sendSessionInitNotice(message.channel, response.sessionInit, previousSessionId);
        }

        // Remove hourglass on completion
        try {
          if (message.client.user) await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user.id);
        } catch { /* ignore reaction errors */ }
      } catch (error) {
        await discordMessageSender.cancelStreaming(channelId);

        // Remove hourglass on error
        try {
          if (message.client.user) await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user.id);
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