import { Context } from 'grammy';
import { config } from '../config.js';
import { splitMessage, formatForTelegram } from './markdown.js';

interface StreamState {
  messageId: number | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
  charIndex: number;
}

const STREAMING_CURSOR = ' ●';
const TYPING_INDICATOR = 'typing...';

export class MessageSender {
  private streamStates: Map<number, StreamState> = new Map();

  async sendMessage(ctx: Context, text: string): Promise<void> {
    const formatted = formatForTelegram(text);
    const parts = splitMessage(formatted, config.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'HTML' });
      } catch {
        // Fallback to plain text if HTML fails
        await ctx.reply(text, { parse_mode: undefined });
      }
    }
  }

  async startStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const message = await ctx.reply(TYPING_INDICATOR);

    this.streamStates.set(chatId, {
      messageId: message.message_id,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      charIndex: 0,
    });
  }

  async updateStream(ctx: Context, content: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);
    if (!state || !state.messageId) return;

    state.content = content;

    if (state.updateScheduled) return;

    const timeSinceLastUpdate = Date.now() - state.lastUpdate;
    const debounceMs = Math.min(config.STREAMING_DEBOUNCE_MS, 150); // Cap at 150ms for smoother updates

    if (timeSinceLastUpdate >= debounceMs) {
      await this.flushUpdate(ctx, state);
    } else {
      state.updateScheduled = true;
      setTimeout(async () => {
        state.updateScheduled = false;
        await this.flushUpdate(ctx, state);
      }, debounceMs - timeSinceLastUpdate);
    }
  }

  private async flushUpdate(ctx: Context, state: StreamState): Promise<void> {
    if (!state.messageId) return;

    let displayContent = state.content.length > 0
      ? state.content.substring(0, config.MAX_MESSAGE_LENGTH - 10) + STREAMING_CURSOR
      : TYPING_INDICATOR;

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        state.messageId,
        displayContent,
        { parse_mode: undefined } // Use plain text during streaming for reliability
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      if (error instanceof Error && !error.message.includes('message is not modified')) {
        console.error('Error updating stream:', error);
      }
    }
  }

  async finishStreaming(ctx: Context, finalContent: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);

    if (state?.messageId) {
      const formatted = formatForTelegram(finalContent);
      const parts = splitMessage(formatted, config.MAX_MESSAGE_LENGTH);

      try {
        // Try HTML mode first for rich formatting
        try {
          await ctx.api.editMessageText(
            chatId,
            state.messageId,
            parts[0] || 'Done.',
            { parse_mode: 'HTML' }
          );
        } catch {
          // Fallback to plain text
          await ctx.api.editMessageText(
            chatId,
            state.messageId,
            finalContent.substring(0, config.MAX_MESSAGE_LENGTH) || 'Done.',
            { parse_mode: undefined }
          );
        }

        // Send additional messages for remaining parts
        for (let i = 1; i < parts.length; i++) {
          try {
            await ctx.reply(parts[i], { parse_mode: 'HTML' });
          } catch {
            await ctx.reply(parts[i], { parse_mode: undefined });
          }
        }
      } catch (error) {
        console.error('Error finishing stream:', error);
      }
    }

    this.streamStates.delete(chatId);
  }

  async cancelStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);
    if (state?.messageId) {
      try {
        await ctx.api.editMessageText(
          chatId,
          state.messageId,
          '⚠️ Request cancelled',
          { parse_mode: undefined }
        );
      } catch (error) {
        console.error('Error cancelling stream:', error);
      }
    }

    this.streamStates.delete(chatId);
  }
}

export const messageSender = new MessageSender();
