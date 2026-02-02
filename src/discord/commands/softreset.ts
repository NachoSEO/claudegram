import { ChatInputCommandInteraction } from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { clearConversation } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { resetRequest, clearQueue } from '../../claude/request-queue.js';

export async function handleSoftReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);

  await resetRequest(chatId);
  clearQueue(chatId);
  clearConversation(chatId);
  sessionManager.clearSession(chatId);

  await interaction.reply({ content: 'Session reset. Use `/project` to start a new session.', ephemeral: true });
}
