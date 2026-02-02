import {
  ChatInputCommandInteraction,
} from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import {
  queueRequest,
  setAbortController,
} from '../../claude/request-queue.js';

async function streamResponse(
  chatId: number,
  channelId: string,
  message: string,
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
  } catch (error) {
    await discordMessageSender.cancelStreaming(channelId);
    throw error;
  }
}

export async function handleChat(interaction: ChatInputCommandInteraction): Promise<void> {
  const message = interaction.options.getString('message', true);
  const channelId = interaction.channelId;

  // Session key uses the user's ID
  const chatId = discordChatId(interaction.user.id);

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await interaction.reply({ content: 'No project set. Use `/project <path>` first.', ephemeral: true });
    return;
  }

  // Respond inline via the interaction (deferReply + editReply with embeds)
  await discordMessageSender.startStreaming(interaction, channelId);

  await queueRequest(chatId, message, async () => {
    await streamResponse(chatId, channelId, message);
  });
}
