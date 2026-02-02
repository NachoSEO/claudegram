import { ChatInputCommandInteraction } from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { clearConversation } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';

export async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);

  const session = sessionManager.getSession(chatId);
  if (!session) {
    await interaction.reply({ content: 'No active session.', ephemeral: true });
    return;
  }

  clearConversation(chatId);

  await interaction.reply({
    content: 'Conversation history cleared. Session and project remain active.',
    ephemeral: true,
  });
}
