import { Message, AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';
import { generateSpeech } from '../tts/tts.js';
import { getTTSSettings, isTTSEnabled } from '../tts/tts-settings.js';
import { discordChatId } from './id-mapper.js';

function stripMarkdown(input: string): string {
  let text = input;
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/[\*_~]/g, '');
  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/\n{2,}/g, '\n');
  return text.trim();
}

function looksLikeError(text: string): boolean {
  return /^(❌|⚠️|Error:)/.test(text.trim());
}

function truncateToMax(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?')
  );
  if (lastPeriod > 200) return truncated.slice(0, lastPeriod + 1);
  return truncated;
}

/** Get the file extension for the current TTS provider/format. */
function getTTSFileExtension(): string {
  if (config.TTS_PROVIDER === 'groq') return 'ogg';
  if (config.TTS_RESPONSE_FORMAT === 'opus') return 'ogg';
  return config.TTS_RESPONSE_FORMAT || 'mp3';
}

/**
 * If TTS is enabled for this user, generate speech from the response
 * and send as an audio attachment in Discord.
 */
export async function maybeSendDiscordVoiceReply(
  message: Message,
  text: string,
): Promise<void> {
  const chatId = discordChatId(message.author.id);
  if (!isTTSEnabled(chatId)) return;

  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  if (!hasKey) return;
  if (looksLikeError(text)) return;

  const cleaned = stripMarkdown(text);
  if (cleaned.length < 5) return;

  const safeText = truncateToMax(cleaned, config.TTS_MAX_CHARS);
  if (!safeText) return;

  try {
    const settings = getTTSSettings(chatId);
    const audioBuffer = await generateSpeech(safeText, settings.voice);
    const ext = getTTSFileExtension();
    const attachment = new AttachmentBuilder(audioBuffer, { name: `response.${ext}` });

    if ('send' in message.channel) {
      await message.channel.send({ files: [attachment] });
    }
  } catch (error) {
    console.error('[Discord TTS] Failed to generate or send voice reply:', error);
  }
}

/**
 * Variant for interaction-based flows (slash commands).
 * Sends TTS audio as a follow-up in the given channel.
 */
export async function maybeSendDiscordVoiceReplyToChannel(
  userId: string,
  channelId: string,
  text: string,
): Promise<void> {
  const { getDiscordClient } = await import('./discord-bot.js');
  const chatId = discordChatId(userId);
  if (!isTTSEnabled(chatId)) return;

  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  if (!hasKey) return;
  if (looksLikeError(text)) return;

  const cleaned = stripMarkdown(text);
  if (cleaned.length < 5) return;

  const safeText = truncateToMax(cleaned, config.TTS_MAX_CHARS);
  if (!safeText) return;

  try {
    const settings = getTTSSettings(chatId);
    const audioBuffer = await generateSpeech(safeText, settings.voice);
    const ext = getTTSFileExtension();
    const attachment = new AttachmentBuilder(audioBuffer, { name: `response.${ext}` });

    const client = getDiscordClient();
    const channel = await client?.channels.fetch(channelId);
    if (channel && 'send' in channel) {
      await channel.send({ files: [attachment] });
    }
  } catch (error) {
    console.error('[Discord TTS] Failed to generate or send voice reply:', error);
  }
}
