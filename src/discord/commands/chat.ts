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
import { sendCompactionNotice, sendSessionInitNotice } from '../compaction-notice.js';

async function streamResponse(
  chatId: number,
  channelId: string,
  message: string,
  channel: any,
  previousSessionId?: string,
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
    });

    await discordMessageSender.finishStreaming(channelId, response.text);

    // Context visibility notifications
    await sendCompactionNotice(channel, response.compaction);
    await sendSessionInitNotice(channel, chatId, response.sessionInit, previousSessionId);
  } catch (error) {
    await discordMessageSender.cancelStreaming(channelId);
    throw error;
  }
}

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
    await queueRequest(chatId, message, async () => {
      await streamResponse(chatId, channelId, message, interaction.channel!, prevSid);
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
    await queueRequest(chatId, message, async () => {
      await streamResponse(chatId, threadChannelId, message, thread, prevSid);
    });
  }
}
