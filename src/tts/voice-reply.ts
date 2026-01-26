import { Context, InputFile } from 'grammy';
import { config } from '../config.js';
import { generateSpeech } from './openai-tts.js';
import { getTTSSettings, isTTSEnabled } from './tts-settings.js';

function stripMarkdown(input: string): string {
  let text = input;

  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  // Inline code
  text = text.replace(/`([^`]*)`/g, '$1');
  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Bold/italic/strikethrough markers
  text = text.replace(/[\*_~]/g, '');
  // Headers
  text = text.replace(/^#+\s+/gm, '');
  // Blockquotes
  text = text.replace(/^>\s?/gm, '');
  // List markers
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  // Collapse extra whitespace
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

  if (lastPeriod > 200) {
    return truncated.slice(0, lastPeriod + 1);
  }

  return truncated;
}

export async function maybeSendVoiceReply(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (!isTTSEnabled(chatId)) return;
  if (!config.OPENAI_API_KEY) return;
  if (looksLikeError(text)) return;

  const cleaned = stripMarkdown(text);
  if (cleaned.length < 5) return;

  const safeText = truncateToMax(cleaned, config.TTS_MAX_CHARS);
  if (!safeText) return;

  try {
    const settings = getTTSSettings(chatId);
    const audioBuffer = await generateSpeech(safeText, settings.voice);
    const format = config.TTS_RESPONSE_FORMAT === 'opus' ? 'ogg' : config.TTS_RESPONSE_FORMAT;
    await ctx.replyWithVoice(new InputFile(audioBuffer, `response.${format}`));
  } catch (error) {
    console.error('[TTS] Failed to generate or send voice reply:', error);
  }
}
