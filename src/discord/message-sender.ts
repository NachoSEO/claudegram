import {
  ChatInputCommandInteraction,
  Message,
  EmbedBuilder,
  AttachmentBuilder,
  ActivityType,
  TextBasedChannel,
} from 'discord.js';
import { discordConfig } from './discord-config.js';
import { getDiscordClient } from './discord-bot.js';
import { splitDiscordMessage } from './markdown.js';
import {
  getSpinnerFrame,
  getToolIcon,
  renderStatusLine,
  extractToolDetail,
  TOOL_ICONS,
} from '../telegram/terminal-renderer.js';

const ESC = '\x1b';

/**
 * Inject real ESC bytes into ```ansi code blocks.
 * Claude outputs literal text like [1;33m — Discord needs \x1b[1;33m.
 */
function injectAnsiEscapes(content: string): string {
  return content.replace(/```ansi\n([\s\S]*?)```/g, (_match, block: string) => {
    let processed = block;
    // Convert literal \u001b or \x1b text to real ESC byte
    processed = processed.replace(/\\u001b\[/g, ESC + '[');
    processed = processed.replace(/\\x1b\[/g, ESC + '[');
    // Inject ESC before any remaining bare ANSI codes [0m, [1;33m, etc.
    // Negative lookbehind ensures we don't double-inject
    processed = processed.replace(/(?<!\x1b)\[(\d+(?:;\d+)*)m/g, ESC + '[$1m');
    return '```ansi\n' + processed + '```';
  });
}

interface ToolOperation {
  name: string;
  detail?: string;
}

interface DiscordStreamState {
  channelId: string;
  /** The message being edited for streaming. */
  message: Message | null;
  /** The interaction that started this stream (if slash command). */
  interaction: ChatInputCommandInteraction | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
  // Terminal UI
  spinnerIndex: number;
  spinnerInterval: NodeJS.Timeout | null;
  currentOperation: ToolOperation | null;
}

const SPINNER_INTERVAL_MS = 1500;
const EMBED_COLOR = 0x7C3AED; // Purple accent
const THINKING_COLOR = 0x5865F2; // Discord blurple
const TOOL_COLOR = 0xEB459E; // Discord fuchsia
const WRITING_COLOR = 0x57F287; // Discord green

// Animated thinking frames — cycles through visually distinct states
const THINKING_FRAMES = [
  { dots: '●○○', text: 'Processing' },
  { dots: '●●○', text: 'Processing.' },
  { dots: '●●●', text: 'Processing..' },
  { dots: '○●●', text: 'Processing...' },
  { dots: '○○●', text: 'Processing..' },
  { dots: '○○○', text: 'Processing.' },
  { dots: '◉○○', text: 'Thinking' },
  { dots: '○◉○', text: 'Thinking.' },
  { dots: '○○◉', text: 'Thinking..' },
  { dots: '◉◉○', text: 'Thinking...' },
  { dots: '○◉◉', text: 'Thinking..' },
  { dots: '◉○◉', text: 'Thinking.' },
];
const EMBED_MAX_DESCRIPTION = 4096;
const MAX_EMBEDS_PER_MESSAGE = 10;
const PLAIN_TEXT_THRESHOLD = 2000; // Under this: plain markdown message
// If total content exceeds this, send as .md file instead of many embeds
const FILE_FALLBACK_THRESHOLD = EMBED_MAX_DESCRIPTION * 4;

/**
 * Build EmbedBuilder(s) from a response string.
 * Splits at 4096-char embed description boundary.
 */
function buildResponseEmbeds(content: string): EmbedBuilder[] {
  const chunks = splitDiscordMessage(content, EMBED_MAX_DESCRIPTION);
  const embeds: EmbedBuilder[] = [];

  for (let i = 0; i < chunks.length && i < MAX_EMBEDS_PER_MESSAGE; i++) {
    const embed = new EmbedBuilder()
      .setDescription(chunks[i])
      .setColor(EMBED_COLOR);

    // Only set footer on the last embed if there are multiple
    if (chunks.length > 1 && i === chunks.length - 1) {
      embed.setFooter({ text: `Part ${i + 1} of ${chunks.length}` });
    } else if (chunks.length > 1) {
      embed.setFooter({ text: `Part ${i + 1} of ${chunks.length}` });
    }

    embeds.push(embed);
  }

  return embeds;
}

function buildThinkingEmbed(frameIndex: number): EmbedBuilder {
  const frame = THINKING_FRAMES[frameIndex % THINKING_FRAMES.length];
  return new EmbedBuilder()
    .setColor(THINKING_COLOR)
    .setDescription(`**${frame.dots}** ${frame.text}`);
}

function buildToolEmbed(
  spinnerIndex: number,
  toolName: string,
  action: string,
  detail: string | undefined,
  contentLength: number,
  lineCount: number,
): EmbedBuilder {
  const icon = getToolIcon(toolName);
  const frame = getSpinnerFrame(spinnerIndex);
  const embed = new EmbedBuilder()
    .setColor(TOOL_COLOR)
    .setDescription(`${frame} ${icon} **${action}** ${detail || ''}`);
  if (contentLength > 0) {
    embed.setFooter({ text: `${contentLength.toLocaleString()} chars | ${lineCount} lines` });
  }
  return embed;
}

export class DiscordMessageSender {
  private streamStates: Map<string, DiscordStreamState> = new Map();

  /**
   * Check if a channel currently has an active stream.
   */
  isStreaming(channelId: string): boolean {
    return this.streamStates.has(channelId);
  }

  /**
   * Register a deferred interaction as a stream state so streaming
   * updates and finishStreaming work against it.
   */
  registerDeferredInteraction(interaction: ChatInputCommandInteraction, channelId: string): void {
    const state: DiscordStreamState = {
      channelId,
      message: null,
      interaction,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
    };
    state.spinnerInterval = this.startSpinnerAnimation(channelId, state);
    this.streamStates.set(channelId, state);
  }

  /**
   * Start streaming for a slash command interaction.
   * Calls deferReply() and stores state.
   */
  async startStreaming(interaction: ChatInputCommandInteraction, channelId: string): Promise<void> {
    await interaction.deferReply();

    const state: DiscordStreamState = {
      channelId,
      message: null,
      interaction,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
    };

    state.spinnerInterval = this.startSpinnerAnimation(channelId, state);
    this.streamStates.set(channelId, state);
  }

  /**
   * Start streaming for a follow-up thread message.
   * Sends an initial "thinking" message to edit in place.
   */
  async startStreamingFromMessage(message: Message, channelId: string): Promise<void> {
    // Reply to the user's message with an animated thinking embed
    const thinkingMsg = await message.reply({ embeds: [buildThinkingEmbed(0)] });

    const state: DiscordStreamState = {
      channelId,
      message: thinkingMsg,
      interaction: null,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
    };

    state.spinnerInterval = this.startSpinnerAnimation(channelId, state);
    this.streamStates.set(channelId, state);
  }

  /**
   * Start streaming by editing an existing message in-place.
   * Used when the caller has already sent a "Thinking..." message (e.g. in a thread).
   */
  async startStreamingFromExistingMessage(message: Message, channelId: string): Promise<void> {
    const state: DiscordStreamState = {
      channelId,
      message,
      interaction: null,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
    };

    state.spinnerInterval = this.startSpinnerAnimation(channelId, state);
    this.streamStates.set(channelId, state);
  }

  /**
   * Start streaming as a regular message (not a reply) in a channel/thread.
   * Used for thread follow-ups where the bot should NOT inline-reply.
   */
  async startStreamingInChannel(channel: TextBasedChannel & { send: Function }, channelId: string): Promise<void> {
    const thinkingMsg = await channel.send({ embeds: [buildThinkingEmbed(0)] });

    const state: DiscordStreamState = {
      channelId,
      message: thinkingMsg,
      interaction: null,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
    };

    state.spinnerInterval = this.startSpinnerAnimation(channelId, state);
    this.streamStates.set(channelId, state);
  }

  private startSpinnerAnimation(channelId: string, state: DiscordStreamState): NodeJS.Timeout {
    const interval = setInterval(() => {
      const currentState = this.streamStates.get(channelId);
      if (!currentState || currentState !== state) {
        clearInterval(interval);
        return;
      }

      state.spinnerIndex++;
      this.flushUpdate(state).catch(() => {});
    }, SPINNER_INTERVAL_MS);
    interval.unref();
    return interval;
  }

  private stopSpinner(state: DiscordStreamState): void {
    if (state.spinnerInterval) {
      clearInterval(state.spinnerInterval);
      state.spinnerInterval = null;
    }
  }

  /**
   * Update the current tool operation (terminal UI style).
   */
  updateToolOperation(channelId: string, toolName: string, input?: Record<string, unknown>): void {
    const state = this.streamStates.get(channelId);
    if (!state) return;

    const detail = input ? extractToolDetail(toolName, input) : undefined;
    state.currentOperation = { name: toolName, detail };

    // Update bot presence with current tool activity
    const client = getDiscordClient();
    if (client?.user) {
      const action = this.getToolAction(toolName);
      const presenceDetail = input ? extractToolDetail(toolName, input) : '';
      client.user.setActivity(`${action} ${presenceDetail || ''}`.trim(), { type: ActivityType.Custom });
    }
  }

  /**
   * Clear the current tool operation.
   */
  clearToolOperation(channelId: string): void {
    const state = this.streamStates.get(channelId);
    if (!state) return;
    state.currentOperation = null;

    const client = getDiscordClient();
    if (client?.user) {
      client.user.setActivity('Ready', { type: ActivityType.Custom });
    }
  }

  /**
   * Update stream content with debouncing.
   * Streaming updates use plain text (fast, no formatting overhead).
   */
  async updateStream(channelId: string, content: string): Promise<void> {
    const state = this.streamStates.get(channelId);
    if (!state) return;

    state.content = content;

    if (state.updateScheduled) return;

    const timeSinceLastUpdate = Date.now() - state.lastUpdate;
    const debounce = discordConfig.DISCORD_STREAMING_DEBOUNCE_MS;

    if (timeSinceLastUpdate >= debounce) {
      await this.flushUpdate(state);
    } else {
      state.updateScheduled = true;
      const delay = debounce - timeSinceLastUpdate;
      setTimeout(async () => {
        state.updateScheduled = false;
        await this.flushUpdate(state);
      }, delay);
    }
  }

  private async flushUpdate(state: DiscordStreamState): Promise<void> {
    const currentState = this.streamStates.get(state.channelId);
    if (!currentState || currentState !== state) return;

    const maxLen = discordConfig.DISCORD_MAX_MESSAGE_LENGTH - 200;
    let content: string | undefined;
    let embed: EmbedBuilder | undefined;

    if (state.currentOperation) {
      // Tool is active — show as a colored embed
      const action = this.getToolAction(state.currentOperation.name);
      const detail = state.currentOperation.detail || undefined;
      const lines = state.content ? state.content.split('\n').length : 0;
      embed = buildToolEmbed(
        state.spinnerIndex,
        state.currentOperation.name,
        action,
        detail,
        state.content.length,
        lines,
      );
    } else if (state.content) {
      // Text streaming — show tail of content as plain text (fast, readable)
      if (state.content.length <= maxLen) {
        content = state.content;
      } else {
        const tail = state.content.slice(-maxLen);
        const clean = tail.slice(tail.indexOf('\n') + 1);
        content = `*... (${state.content.length.toLocaleString()} chars)*\n${clean}`;
      }
    } else {
      // No tool, no content — animated thinking embed
      embed = buildThinkingEmbed(state.spinnerIndex);
    }

    try {
      const payload = embed
        ? { content: '', embeds: [embed] }
        : { content: content || '', embeds: [] };

      if (state.interaction) {
        await state.interaction.editReply(payload);
      } else if (state.message) {
        await state.message.edit(payload);
      }
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (!msg.includes('unknown message') && !msg.includes('missing access')) {
          console.error('[Discord] Error updating stream:', error.message);
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

  /**
   * Finish streaming: render final response as embed(s).
   *
   * Strategy:
   * - Short/medium responses (<=4096 chars): single embed
   * - Long responses (<=~16k chars): multiple embeds (up to 10)
   * - Very long responses (>~16k chars): .md file attachment + summary embed
   */
  async finishStreaming(channelId: string, finalContent: string): Promise<void> {
    const state = this.streamStates.get(channelId);
    if (!state) return;

    this.stopSpinner(state);
    state.currentOperation = null;

    const client = getDiscordClient();
    if (client?.user) {
      client.user.setActivity('Ready', { type: ActivityType.Custom });
    }

    // Inject real ESC bytes into ```ansi code blocks
    const processed = injectAnsiEscapes(finalContent);

    try {
      if (processed.length > FILE_FALLBACK_THRESHOLD) {
        // Very long response — send as .md file with a summary embed
        await this.sendAsFile(state, processed);
      } else if (processed.length <= PLAIN_TEXT_THRESHOLD) {
        // Short response — plain markdown message (feels like normal chat)
        await this.sendAsPlainText(state, processed);
      } else {
        // Medium/long response — send as embed(s)
        await this.sendAsEmbeds(state, processed);
      }
    } catch (error) {
      console.error('[Discord] Error finishing stream:', error);
      // Fallback: try plain text
      try {
        const fallbackParts = splitDiscordMessage(finalContent, discordConfig.DISCORD_MAX_MESSAGE_LENGTH);
        if (state.interaction) {
          await state.interaction.editReply(fallbackParts[0] || 'Done.');
          for (let i = 1; i < fallbackParts.length; i++) {
            await state.interaction.followUp(fallbackParts[i]);
          }
        } else if (state.message) {
          await state.message.edit(fallbackParts[0] || 'Done.');
        }
      } catch {
        // Give up silently
      }
    }

    this.streamStates.delete(channelId);
  }

  private async sendAsPlainText(state: DiscordStreamState, content: string): Promise<void> {
    if (state.interaction) {
      await state.interaction.editReply({ content, embeds: [] });
    } else if (state.message) {
      await state.message.edit({ content, embeds: [] });
    }
  }

  private async sendAsEmbeds(state: DiscordStreamState, content: string): Promise<void> {
    const embeds = buildResponseEmbeds(content);

    if (state.interaction) {
      // Edit the deferred reply with the first batch of embeds (max 10)
      await state.interaction.editReply({ content: '', embeds: embeds.slice(0, MAX_EMBEDS_PER_MESSAGE) });

      // If somehow we need more than 10 embeds, send follow-ups
      for (let i = MAX_EMBEDS_PER_MESSAGE; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
        const batch = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
        await state.interaction.followUp({ embeds: batch });
      }
    } else if (state.message) {
      // Edit the thinking message with the first embed
      // message.edit only supports up to 10 embeds
      await state.message.edit({ content: '', embeds: embeds.slice(0, MAX_EMBEDS_PER_MESSAGE) });

      // Send overflow as new messages
      const chan = state.message.channel;
      if ('send' in chan && embeds.length > MAX_EMBEDS_PER_MESSAGE) {
        for (let i = MAX_EMBEDS_PER_MESSAGE; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
          const batch = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
          await chan.send({ embeds: batch });
        }
      }
    }
  }

  private async sendAsFile(state: DiscordStreamState, content: string): Promise<void> {
    const fileBuffer = Buffer.from(content, 'utf-8');
    const attachment = new AttachmentBuilder(fileBuffer, { name: 'response.md' });

    // Create a summary embed
    const previewLength = 300;
    const preview = content.length > previewLength
      ? content.substring(0, previewLength).replace(/[`]/g, '') + '...'
      : content;

    const summaryEmbed = new EmbedBuilder()
      .setDescription(preview)
      .setColor(EMBED_COLOR)
      .setFooter({ text: `Full response: ${content.length.toLocaleString()} chars — see attached .md file` });

    if (state.interaction) {
      await state.interaction.editReply({
        content: '',
        embeds: [summaryEmbed],
        files: [attachment],
      });
    } else if (state.message) {
      await state.message.edit({ content: '', embeds: [summaryEmbed] });

      // Send file as a follow-up (can't edit to add files on regular messages)
      const chan = state.message.channel;
      if ('send' in chan) {
        await chan.send({ files: [attachment] });
      }
    }
  }

  /**
   * Cancel streaming: update message to show cancellation.
   */
  async cancelStreaming(channelId: string): Promise<void> {
    const state = this.streamStates.get(channelId);
    if (!state) return;

    this.stopSpinner(state);

    const client = getDiscordClient();
    if (client?.user) {
      client.user.setActivity('Ready', { type: ActivityType.Custom });
    }

    try {
      if (state.interaction) {
        await state.interaction.editReply('Request cancelled.');
      } else if (state.message) {
        await state.message.edit('Request cancelled.');
      }
    } catch (error) {
      console.error('[Discord] Error cancelling stream:', error);
    }

    this.streamStates.delete(channelId);
  }
}

export const discordMessageSender = new DiscordMessageSender();
