import { ChatInputCommandInteraction } from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import {
  cancelRequest,
  clearQueue,
  isProcessing,
} from '../../claude/request-queue.js';

export async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);

  const wasProcessing = isProcessing(chatId);
  const cancelled = await cancelRequest(chatId);
  const clearedCount = clearQueue(chatId);

  if (cancelled || clearedCount > 0) {
    let message = 'Cancelled.';
    if (clearedCount > 0) {
      message += ` (${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared)`;
    }
    await interaction.reply({ content: message, ephemeral: true });
  } else if (!wasProcessing) {
    await interaction.reply({ content: 'Nothing to cancel.', ephemeral: true });
  } else {
    await interaction.reply({ content: 'Cancel sent.', ephemeral: true });
  }
}
