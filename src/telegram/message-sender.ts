import { Context, Api, InputFile } from 'grammy';
import { config } from '../config.js';
import { processMessageForTelegram, convertToTelegramMarkdown, escapeMarkdownV2 } from './markdown.js';
import { shouldUseTelegraph, createTelegraphPage, createTelegraphFromFile } from './telegraph.js';
import { isTerminalUIEnabled } from './terminal-settings.js';
import {
  getSpinnerFrame,
  getToolIcon,
  renderStatusLine,
  extractToolDetail,
  TOOL_ICONS,
} from './terminal-renderer.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ToolOperation {
  name: string;
  detail?: string;
}

interface StreamState {
  chatId: number;
  messageId: number | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
  typingInterval: NodeJS.Timeout | null;
  // Terminal UI mode additions
  terminalMode: boolean;
  spinnerIndex: number;
  spinnerInterval: NodeJS.Timeout | null;
  currentOperation: ToolOperation | null;
  backgroundTasks: Array<{ name: string; status: 'running' | 'complete' | 'error' }>;
}

const TYPING_INTERVAL_MS = 4000; // Send typing every 4 seconds
const SPINNER_INTERVAL_MS = 150; // Spinner animation speed

export class MessageSender {
  private streamStates: Map<number, StreamState> = new Map();

  /**
   * Send a message with hybrid approach:
   * - Short content: MarkdownV2 inline
   * - Long content or tables: Telegraph page link
   */
  async sendMessage(ctx: Context, text: string): Promise<void> {
    // Check if we should use Telegraph for this content
    if (shouldUseTelegraph(text)) {
      const pageUrl = await createTelegraphPage('Claude Response', text);

      if (pageUrl) {
        // Send Telegraph link with a brief summary
        const summary = text.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
        const message = `📄 *Full response available:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

        try {
          await ctx.reply(message, { parse_mode: 'MarkdownV2' });
          return;
        } catch (error) {
          console.error('[Telegraph] Failed to send link, falling back to chunks:', error);
        }
      }
    }

    // Default: MarkdownV2 with chunking
    const parts = processMessageForTelegram(text, config.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        // If MarkdownV2 fails, try with escaped plain text
        console.error('MarkdownV2 send failed, trying escaped fallback:', error);
        try {
          await ctx.reply(escapeMarkdownV2(text), { parse_mode: 'MarkdownV2' });
        } catch (fallbackError) {
          // Last resort: send as plain text
          console.error('Fallback also failed, sending plain text:', fallbackError);
          await ctx.reply(text, { parse_mode: undefined });
        }
      }
    }
  }

  /**
   * Send a file as a document attachment
   */
  async sendDocument(ctx: Context, filePath: string, caption?: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Document] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const inputFile = new InputFile(fileBuffer, fileName);

      await ctx.replyWithDocument(inputFile, {
        caption: caption ? escapeMarkdownV2(caption) : undefined,
        parse_mode: caption ? 'MarkdownV2' : undefined
      });

      return true;
    } catch (error) {
      console.error('[Document] Failed to send:', error);
      return false;
    }
  }

  /**
   * Send a markdown file with Telegraph preview option
   */
  async sendMarkdownFile(
    ctx: Context,
    filePath: string,
    options: { useTelegraph?: boolean; sendAsDocument?: boolean } = {}
  ): Promise<boolean> {
    const { useTelegraph = true, sendAsDocument = false } = options;

    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Markdown] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Option 1: Telegraph (Instant View)
      if (useTelegraph) {
        const pageUrl = await createTelegraphFromFile(filePath);

        if (pageUrl) {
          const message = `📄 *${escapeMarkdownV2(fileName)}*\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

          await ctx.reply(message, { parse_mode: 'MarkdownV2' });

          // Also send as document if requested
          if (sendAsDocument) {
            await this.sendDocument(ctx, filePath, 'Download file');
          }

          return true;
        }
      }

      // Option 2: Send as document
      if (sendAsDocument) {
        return await this.sendDocument(ctx, filePath, `📎 ${fileName}`);
      }

      // Option 3: Send content inline
      await this.sendMessage(ctx, content);
      return true;
    } catch (error) {
      console.error('[Markdown] Failed to send:', error);
      return false;
    }
  }

  async startStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const terminalMode = isTerminalUIEnabled(chatId);
    const initialText = terminalMode ? `${getSpinnerFrame(0)} ${TOOL_ICONS.thinking} Thinking...` : '▌';
    const message = await ctx.reply(initialText, { parse_mode: undefined });

    // Start continuous typing indicator
    const typingInterval = this.startTypingIndicator(ctx.api, chatId);

    const state: StreamState = {
      chatId,
      messageId: message.message_id,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      typingInterval,
      // Terminal UI mode
      terminalMode,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
      backgroundTasks: [],
    };

    // Start spinner animation if terminal mode
    if (terminalMode) {
      state.spinnerInterval = this.startSpinnerAnimation(ctx, chatId, state);
    }

    this.streamStates.set(chatId, state);
  }

  private startSpinnerAnimation(ctx: Context, chatId: number, state: StreamState): NodeJS.Timeout {
    return setInterval(() => {
      // Check if state is still active (not cleaned up)
      const currentState = this.streamStates.get(chatId);
      if (!currentState || currentState !== state || !state.messageId) {
        // State was cleaned up, stop the interval
        if (state.spinnerInterval) {
          clearInterval(state.spinnerInterval);
          state.spinnerInterval = null;
        }
        return;
      }

      state.spinnerIndex = (state.spinnerIndex + 1) % 10;
      // Trigger a display update if we have a current operation
      if (state.currentOperation) {
        this.flushTerminalUpdate(ctx, state).catch(() => {});
      }
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinnerAnimation(state: StreamState): void {
    if (state.spinnerInterval) {
      clearInterval(state.spinnerInterval);
      state.spinnerInterval = null;
    }
  }

  private startTypingIndicator(api: Api, chatId: number): NodeJS.Timeout {
    // Send typing immediately
    api.sendChatAction(chatId, 'typing').catch(() => {});

    // Then send every TYPING_INTERVAL_MS
    return setInterval(() => {
      api.sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private stopTypingIndicator(state: StreamState): void {
    if (state.typingInterval) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }

  /**
   * Update the current tool operation (terminal UI mode)
   */
  updateToolOperation(chatId: number, toolName: string, input?: Record<string, unknown>): void {
    const state = this.streamStates.get(chatId);
    if (!state || !state.terminalMode) return;

    const detail = input ? extractToolDetail(toolName, input) : undefined;
    state.currentOperation = { name: toolName, detail };
  }

  /**
   * Clear the current tool operation (terminal UI mode)
   */
  clearToolOperation(chatId: number): void {
    const state = this.streamStates.get(chatId);
    if (!state) return;
    state.currentOperation = null;
  }

  /**
   * Add or update a background task status (terminal UI mode)
   */
  updateBackgroundTask(chatId: number, taskName: string, status: 'running' | 'complete' | 'error'): void {
    const state = this.streamStates.get(chatId);
    if (!state || !state.terminalMode) return;

    const existing = state.backgroundTasks.find(t => t.name === taskName);
    if (existing) {
      existing.status = status;
    } else {
      state.backgroundTasks.push({ name: taskName, status });
    }
  }

  private async flushTerminalUpdate(ctx: Context, state: StreamState): Promise<void> {
    // Verify state is still active
    const currentState = this.streamStates.get(state.chatId);
    if (!currentState || currentState !== state || !state.messageId || !state.terminalMode) {
      return;
    }

    const parts: string[] = [];

    // Add status line if there's a current operation
    if (state.currentOperation) {
      const icon = getToolIcon(state.currentOperation.name);
      const action = this.getToolAction(state.currentOperation.name);
      const detail = state.currentOperation.detail ? ` ${state.currentOperation.detail}` : '';
      parts.push(renderStatusLine(state.spinnerIndex, icon, action, detail ? detail.trim() : undefined));
      if (state.content) parts.push('');
    }

    // Add content (truncated)
    if (state.content) {
      const maxContentLen = config.MAX_MESSAGE_LENGTH - 200; // Reserve space for status
      const truncatedContent = state.content.length > maxContentLen
        ? state.content.substring(0, maxContentLen) + '...'
        : state.content;
      parts.push(truncatedContent);
    }

    // Add background tasks
    if (state.backgroundTasks.length > 0) {
      if (state.content || state.currentOperation) parts.push('');
      for (const task of state.backgroundTasks) {
        const statusIcon = task.status === 'complete' ? TOOL_ICONS.complete
          : task.status === 'error' ? TOOL_ICONS.error
          : getSpinnerFrame(state.spinnerIndex);
        parts.push(`${TOOL_ICONS.Task} ${task.name} ${statusIcon}`);
      }
    }

    // If nothing to show, show thinking indicator
    if (parts.length === 0) {
      parts.push(`${getSpinnerFrame(state.spinnerIndex)} ${TOOL_ICONS.thinking} Thinking...`);
    }

    const displayContent = parts.join('\n');

    try {
      await ctx.api.editMessageText(
        state.chatId,
        state.messageId,
        displayContent,
        { parse_mode: undefined }
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      // Ignore "message not modified" and "message ID invalid" errors
      // The latter happens when streaming ends and message is replaced
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (!msg.includes('message is not modified') && !msg.includes('message_id_invalid')) {
          console.error('Error updating terminal stream:', error);
        }
      }
    }
  }

  private getToolAction(toolName: string): string {
    const actions: Record<string, string> = {
      Read: 'Reading',
      Write: 'Writing',
      Edit: 'Editing',
      Bash: 'Running',
      Grep: 'Searching',
      Glob: 'Finding files',
      Task: 'Running task',
      WebFetch: 'Fetching',
      WebSearch: 'Searching web',
      NotebookEdit: 'Editing notebook',
    };
    return actions[toolName] || toolName;
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

    // Use terminal-style update if enabled
    if (state.terminalMode) {
      await this.flushTerminalUpdate(ctx, state);
      return;
    }

    // For streaming updates, keep it simple - just show truncated content with cursor
    // Don't convert to MarkdownV2 during streaming to avoid parsing errors mid-message
    const displayContent = state.content.length > 0
      ? state.content.substring(0, config.MAX_MESSAGE_LENGTH - 10) + ' ▌'
      : '▌';

    try {
      await ctx.api.editMessageText(
        state.chatId,
        state.messageId,
        displayContent,
        { parse_mode: undefined } // Plain text during streaming for stability
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      // Ignore "message not modified" and "message ID invalid" errors
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (!msg.includes('message is not modified') && !msg.includes('message_id_invalid')) {
          console.error('Error updating stream:', error);
        }
      }
    }
  }

  async finishStreaming(ctx: Context, finalContent: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);

    if (state) {
      // Stop typing indicator and spinner
      this.stopTypingIndicator(state);
      this.stopSpinnerAnimation(state);
      state.currentOperation = null;

      if (state.messageId) {
        // Check if we should use Telegraph for final content
        if (shouldUseTelegraph(finalContent)) {
          const pageUrl = await createTelegraphPage('Claude Response', finalContent);

          if (pageUrl) {
            try {
              const summary = finalContent.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
              const message = `📄 *Response ready:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

              await ctx.api.editMessageText(
                chatId,
                state.messageId,
                message,
                { parse_mode: 'MarkdownV2' }
              );

              this.streamStates.delete(chatId);
              return;
            } catch (error) {
              console.error('[Telegraph] Failed, falling back to chunks:', error);
            }
          }
        }

        // Default: MarkdownV2 with chunking
        const parts = processMessageForTelegram(finalContent, config.MAX_MESSAGE_LENGTH);

        try {
          // Update the first message with first part (use MarkdownV2)
          const firstPart = parts[0] || 'Done\\.';

          try {
            await ctx.api.editMessageText(
              chatId,
              state.messageId,
              firstPart,
              { parse_mode: 'MarkdownV2' }
            );

            // Send additional messages for remaining parts
            for (let i = 1; i < parts.length; i++) {
              try {
                await ctx.reply(parts[i], { parse_mode: 'MarkdownV2' });
              } catch (partError) {
                console.error(`MarkdownV2 failed for part ${i + 1}:`, partError);
                await ctx.reply(parts[i], { parse_mode: undefined });
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (mdError) {
            // MarkdownV2 failed — delete streaming placeholder and
            // re-send via sendMessage which handles Telegraph + chunking
            console.error('MarkdownV2 edit failed, falling back to sendMessage:', mdError);
            try {
              await ctx.api.deleteMessage(chatId, state.messageId);
            } catch { /* ignore */ }

            this.streamStates.delete(chatId);
            await this.sendMessage(ctx, finalContent);
            return;
          }
        } catch (error) {
          console.error('Error finishing stream:', error);
        }
      }
    }

    this.streamStates.delete(chatId);
  }

  async cancelStreaming(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = this.streamStates.get(chatId);
    if (state) {
      // Stop typing indicator and spinner
      this.stopTypingIndicator(state);
      this.stopSpinnerAnimation(state);

      if (state.messageId) {
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
    }

    this.streamStates.delete(chatId);
  }

  // Send typing indicator for a specific chat (useful for long operations)
  async sendTyping(ctx: Context): Promise<void> {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
    } catch (error) {
      console.error('Error sending typing:', error);
    }
  }
}

export const messageSender = new MessageSender();
