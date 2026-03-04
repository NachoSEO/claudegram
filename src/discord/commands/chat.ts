import {
  ChatInputCommandInteraction,
  ChannelType,
  TextChannel,
  EmbedBuilder,
} from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import {
  queueRequest,
  setAbortController,
} from '../../claude/request-queue.js';
import type { JobOrigin } from '../../providers/types.js';
import { sendCompactionNotice, sendSessionInitNotice } from '../compaction-notice.js';

/**
 * Streams an agent response for a user message into the specified stream, updating progress and tool-operation indicators, then posts compaction and session-initialization notices.
 *
 * @param channel - Discord channel object used to post compaction and session-init notices
 * @param previousSessionId - Previous session id to include in the session-init notice, if present
 */
async function streamResponse(
  chatId: number,
  channelId: string,
  message: string,
  channel: { send: (...args: any[]) => Promise<any> },
  previousSessionId?: string,
  jobOrigin?: JobOrigin,
): Promise<void> {
  const abortController = new AbortController();
  setAbortController(chatId, abortController);

  try {
    const response = await sendToAgent(chatId, message, {
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
      jobOrigin,
    });

    await discordMessageSender.finishStreaming(channelId, response.text);

    // Context visibility notifications
    await sendCompactionNotice(channel, response.compaction);
    await sendSessionInitNotice(channel, response.sessionInit, previousSessionId);
  } catch (error) {
    await discordMessageSender.cancelStreaming(channelId);
    throw error;
  }
}

/**
 * Handle the `/chat` command by validating the user's session and streaming the agent's response.
 *
 * If the user has no active project session, replies ephemerally with instructions to set one.
 * If the command is issued inside a thread, streams the agent response inline in that thread.
 * If issued in a channel, creates a new thread, posts an initial "Processing" message, and streams the response into the new thread.
 * The user's previous session identifier (if any) is preserved to maintain conversation continuity, and the request is queued for serialized processing.
 *
 * @param interaction - The incoming ChatInputCommandInteraction for the `/chat` command
 */
export async function handleChat(interaction: ChatInputCommandInteraction): Promise<void> {
  const message = interaction.options.getString('message', true);

  // Session key uses the user's ID
  const chatId = discordChatId(interaction.user.id);

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await interaction.reply({ content: 'No project set. Use `/project <path>` first.', ephemeral: true });
    return;
  }

  const isThread =
    interaction.channel?.type === ChannelType.PublicThread ||
    interaction.channel?.type === ChannelType.PrivateThread;

  if (isThread) {
    // Already in a thread — respond inline (current behavior)
    const channelId = interaction.channelId;
    await discordMessageSender.startStreaming(interaction, channelId);

    const prevSid = sessionManager.getSession(chatId)?.claudeSessionId;
    const jobOrigin: JobOrigin = {
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      threadId: interaction.channel?.isThread() ? interaction.channelId : undefined,
      userId: interaction.user.id,
    };
    await queueRequest(chatId, message, async () => {
      await streamResponse(
        chatId,
        channelId,
        message,
        interaction.channel as { send: (...args: any[]) => Promise<any> },
        prevSid,
        jobOrigin,
      );
    });
  } else {
    // In a channel — create a thread, stream response there
    await interaction.deferReply();

    const threadTitle = `Claude: ${message.slice(0, 90)}`;
    const channel = interaction.channel;
    if (!channel || !('threads' in channel)) {
      await interaction.editReply('Cannot create thread in this channel type.');
      return;
    }

    const thread = await (channel as TextChannel).threads.create({
      name: threadTitle.slice(0, 100),
      autoArchiveDuration: 1440,
    });

    await interaction.editReply(`Thread created: ${thread.toString()}`);

    // Send initial thinking message in thread, then stream there
    const threadChannelId = thread.id;
    const thinkingEmbed = new EmbedBuilder().setColor(0x5865F2).setDescription('**●○○** Processing');
    const thinkingMsg = await thread.send({ embeds: [thinkingEmbed] });
    await discordMessageSender.startStreamingFromExistingMessage(thinkingMsg, threadChannelId);

    const prevSid = sessionManager.getSession(chatId)?.claudeSessionId;
    const jobOrigin: JobOrigin = {
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      threadId: thread.id,
      userId: interaction.user.id,
    };
    await queueRequest(chatId, message, async () => {
      await streamResponse(chatId, threadChannelId, message, thread, prevSid, jobOrigin);
    });
  }
}