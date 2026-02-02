import type { MessageContextMenuCommandInteraction } from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { queueRequest, setAbortController } from '../../claude/request-queue.js';

export async function handleAskClaude(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  const targetMessage = interaction.targetMessage;
  const text = targetMessage.content;

  if (!text) {
    await interaction.reply({ content: 'That message has no text content.', ephemeral: true });
    return;
  }

  const chatId = discordChatId(interaction.user.id);
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await interaction.reply({ content: 'No project set. Use `/project` first.', ephemeral: true });
    return;
  }

  const prompt = `The user right-clicked this message and asked you to analyze it:\n\n${text}`;

  await interaction.deferReply();
  discordMessageSender.registerDeferredInteraction(interaction as any, interaction.channelId);

  await queueRequest(chatId, prompt, async () => {
    const abortController = new AbortController();
    setAbortController(chatId, abortController);
    try {
      const response = await sendToAgent(chatId, prompt, {
        onProgress: (t) => discordMessageSender.updateStream(interaction.channelId, t),
        onToolStart: (toolName, input) => discordMessageSender.updateToolOperation(interaction.channelId, toolName, input),
        onToolEnd: () => discordMessageSender.clearToolOperation(interaction.channelId),
        abortController,
        platform: 'discord',
      });
      await discordMessageSender.finishStreaming(interaction.channelId, response.text);
    } catch (error) {
      await discordMessageSender.cancelStreaming(interaction.channelId);
      throw error;
    }
  });
}
