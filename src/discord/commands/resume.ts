import {
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  ComponentType,
} from 'discord.js';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../claude/agent.js';

const COLLECTOR_TIMEOUT_MS = 60_000;

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);

  const history = sessionManager.getSessionHistory(chatId, 5);
  const resumable = history.filter((entry) => entry.claudeSessionId);

  if (resumable.length === 0) {
    await interaction.reply({
      content: 'No resumable sessions found.\n\nSessions need at least one Claude response to be resumable.\nUse `/project <path>` to start a new session.',
      ephemeral: true,
    });
    return;
  }

  // Build one button per resumable session (max 5 buttons per row)
  const buttons = resumable.map((entry, i) => {
    const timeAgo = formatTimeAgo(new Date(entry.lastActivity));
    return new ButtonBuilder()
      .setCustomId(`resume-${i}`)
      .setLabel(`${entry.projectName} (${timeAgo})`)
      .setStyle(ButtonStyle.Primary);
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  const response = await interaction.reply({
    content: '**Recent Sessions**\n\nSelect a session to resume:',
    components: [row],
    fetchReply: true,
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: COLLECTOR_TIMEOUT_MS,
  });

  let handled = false;

  collector.on('collect', async (i: ButtonInteraction) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: 'Only the command author can use these buttons.', ephemeral: true });
      return;
    }

    if (handled) return;
    handled = true;

    const index = parseInt(i.customId.replace('resume-', ''), 10);
    if (Number.isNaN(index) || index < 0 || index >= resumable.length) {
      await i.update({ content: 'Invalid session index.', components: [] });
      collector.stop();
      return;
    }
    const entry = resumable[index];
    if (!entry) {
      await i.update({ content: 'Session not found.', components: [] });
      collector.stop();
      return;
    }

    const session = sessionManager.resumeSession(chatId, entry.conversationId);
    if (!session) {
      await i.update({ content: 'Failed to resume session.', components: [] });
      collector.stop();
      return;
    }

    clearConversation(chatId);

    const projectName = path.basename(session.workingDirectory);
    let msg = `Resumed **${projectName}**\n\nWorking directory: \`${session.workingDirectory}\``;
    if (session.claudeSessionId) {
      msg += `\nClaude session: \`${session.claudeSessionId.slice(0, 20)}...\``;
    }

    await i.update({ content: msg, components: [] });
    collector.stop();
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'time' && !handled) {
      const disabledButtons = resumable.map((entry, i) => {
        const timeAgo = formatTimeAgo(new Date(entry.lastActivity));
        return new ButtonBuilder()
          .setCustomId(`resume-${i}`)
          .setLabel(`${entry.projectName} (${timeAgo})`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true);
      });
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButtons);

      try {
        await interaction.editReply({ components: [disabledRow] });
      } catch (err) {
        console.debug('[Discord] Failed to disable resume buttons:', err);
      }
    }
  });
}
