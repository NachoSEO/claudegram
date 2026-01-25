import { Context } from 'grammy';
import { config } from '../config.js';
import { splitMessage } from './markdown.js';

interface StreamState {
  messageId: number | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
}

export class MessageSender {
  private streamStates: Map<number, StreamState> = new Map();

  async sendMessage(ctx: Context, text: string): Promise<void> {
    const parts = splitMessage(text, config.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      await ctx.reply(part, { parse_mode: undefined });
    }
  }

  async startStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const message = await ctx.reply('▌');

    this.streamStates.set(chatId, {
      messageId: message.message_id,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
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

    if (timeSinceLastUpdate >= config.STREAMING_DEBOUNCE_MS) {
      await this.flushUpdate(ctx, state);
    } else {
      state.updateScheduled = true;
      setTimeout(async () => {
        state.updateScheduled = false;
        await this.flushUpdate(ctx, state);
      }, config.STREAMING_DEBOUNCE_MS - timeSinceLastUpdate);
    }
  }

  private async flushUpdate(ctx: Context, state: StreamState): Promise<void> {
    if (!state.messageId) return;

    const displayContent = state.content.length > 0
      ? state.content.substring(0, config.MAX_MESSAGE_LENGTH - 1) + '▌'
      : '▌';

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        state.messageId,
        displayContent,
        { parse_mode: undefined }
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      // Ignore "message not modified" errors
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
      const parts = splitMessage(finalContent, config.MAX_MESSAGE_LENGTH);

      try {
        // Update the first message with first part
        await ctx.api.editMessageText(
          chatId,
          state.messageId,
          parts[0] || 'Done.',
          { parse_mode: undefined }
        );

        // Send additional messages for remaining parts
        for (let i = 1; i < parts.length; i++) {
          await ctx.reply(parts[i], { parse_mode: undefined });
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
