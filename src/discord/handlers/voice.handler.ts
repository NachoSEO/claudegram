import {
  Message,
  Attachment,
} from 'discord.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../config.js';
import { discordChatId } from '../id-mapper.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { transcribeFile } from '../../audio/transcribe.js';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { maybeSendDiscordVoiceReply } from '../voice-reply.js';

/**
 * Handle a Discord voice message (audio attachment with duration).
 * Downloads the audio, transcribes via Groq Whisper, shows the transcript,
 * and sends it to the Claude agent with streaming.
 */
export async function handleVoiceMessage(
  message: Message,
  attachment: Attachment,
  isThread: boolean,
  isMentioned: boolean,
): Promise<void> {
  const chatId = discordChatId(message.author.id);
  const channelId = message.channelId;

  // Check for GROQ_API_KEY
  if (!config.GROQ_API_KEY) {
    await message.reply('Voice transcription not configured. Set GROQ_API_KEY in .env.');
    return;
  }

  // Check session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await message.reply('No project set. Use `/project <path>` first.');
    return;
  }

  // Acknowledge receipt
  const ackMsg = await message.reply('🎤 Transcribing...');

  let tempFilePath: string | null = null;

  try {
    // Determine file extension from content type
    const ext = attachment.contentType?.includes('ogg') ? '.ogg'
      : attachment.contentType?.includes('webm') ? '.webm'
      : attachment.contentType?.includes('mp4') ? '.mp4'
      : '.ogg';

    tempFilePath = path.join(os.tmpdir(), `claudegram_discord_voice_${message.id}${ext}`);

    // Check attachment size before download (Groq Whisper max: 25MB)
    const MAX_AUDIO_SIZE_MB = 25;
    if (attachment.size && attachment.size > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
      throw new Error(`Audio file too large (${(attachment.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_AUDIO_SIZE_MB}MB.`);
    }

    // Download the audio file
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download audio: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

    const fileSize = fs.statSync(tempFilePath).size;
    if (!fileSize) {
      throw new Error('Downloaded empty audio file.');
    }

    console.log(`[Discord Voice] Downloaded ${(fileSize / 1024 / 1024).toFixed(1)}MB to ${tempFilePath}`);

    // Transcribe using Groq Whisper
    const transcript = await transcribeFile(tempFilePath);

    console.log(`[Discord Voice] Transcript (${transcript.length} chars): ${transcript.substring(0, 100)}...`);

    // Show full transcript, chunked to fit Discord's 2000-char limit
    const CHUNK_LIMIT = 1990;
    const firstChunk = transcript.slice(0, CHUNK_LIMIT);
    await ackMsg.edit(`👤 ${firstChunk}`);
    for (let i = CHUNK_LIMIT; i < transcript.length; i += CHUNK_LIMIT) {
      const chunk = transcript.slice(i, i + CHUNK_LIMIT);
      if ('send' in message.channel) {
        await message.channel.send(`👤 ${chunk}`);
      }
    }

    // React with hourglass to indicate processing
    try {
      await message.react('\u23F3');
    } catch { /* ignore reaction errors */ }

    // Show queue position if already processing
    if (isProcessing(chatId)) {
      const position = getQueuePosition(chatId) + 1;
      if ('send' in message.channel) {
        await message.channel.send(`Queued (position ${position})`);
      }
    }

    // Send transcript to agent with streaming
    await queueRequest(chatId, transcript, async () => {
      // In a thread without @mention: regular message; otherwise: inline reply
      if (isThread && !isMentioned) {
        await discordMessageSender.startStreamingInChannel(message.channel as any, channelId);
      } else {
        await discordMessageSender.startStreamingFromMessage(message, channelId);
      }

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const agentResponse = await sendToAgent(chatId, transcript, {
          onProgress: (text) => {
            discordMessageSender.updateStream(channelId, text);
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

        await discordMessageSender.finishStreaming(channelId, agentResponse.text);
        await maybeSendDiscordVoiceReply(message, agentResponse.text);

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

    const errorMessage = sanitizeError(error);
    console.error('[Discord Voice] Error:', errorMessage);

    const errDisplay = errorMessage.length > 1900 ? errorMessage.slice(0, 1900) + '…' : errorMessage;
    try {
      await ackMsg.edit(`❌ Voice error: ${errDisplay}`);
    } catch {
      await message.reply(`❌ Voice error: ${errDisplay}`).catch(() => {});
    }
  } finally {
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Discord Voice] Cleaned up ${sanitizePath(tempFilePath)}`);
      } catch (e) {
        console.warn(`[Discord Voice] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}
