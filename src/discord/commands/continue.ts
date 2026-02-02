import { ChatInputCommandInteraction } from 'discord.js';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../claude/agent.js';

export async function handleContinue(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);

  const session = sessionManager.resumeLastSession(chatId);

  if (!session) {
    await interaction.reply({
      content: 'No previous session to continue.\n\nUse `/project <path>` to start a new session.',
      ephemeral: true,
    });
    return;
  }

  clearConversation(chatId);

  const projectName = path.basename(session.workingDirectory);
  let msg = `Continuing **${projectName}**\n\nWorking directory: \`${session.workingDirectory}\``;
  if (session.claudeSessionId) {
    msg += `\nClaude session: \`${session.claudeSessionId.slice(0, 20)}...\``;
  }

  await interaction.reply({ content: msg, ephemeral: true });
}
