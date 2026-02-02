import { ChatInputCommandInteraction } from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { sessionManager } from '../../claude/session-manager.js';
import { getModel, getCachedUsage, isDangerousMode } from '../../claude/agent.js';
import { isProcessing } from '../../claude/request-queue.js';

export async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);

  const session = sessionManager.getSession(chatId);
  const model = getModel(chatId);
  const processing = isProcessing(chatId);
  const dangerous = isDangerousMode();
  const usage = getCachedUsage(chatId);

  const lines: string[] = ['**Bot Status**\n'];

  if (session) {
    lines.push(`**Project:** \`${session.workingDirectory}\``);
    lines.push(`**Model:** ${model}`);
    lines.push(`**Processing:** ${processing ? 'Yes' : 'No'}`);
    lines.push(`**Dangerous Mode:** ${dangerous ? 'ENABLED' : 'Disabled'}`);

    if (session.claudeSessionId) {
      lines.push(`**Session ID:** \`${session.claudeSessionId}\``);
    }

    if (usage) {
      const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
      const pct = usage.contextWindow > 0 ? Math.round((total / usage.contextWindow) * 100) : 0;
      lines.push(`\n**Context:** ${total.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${pct}%)`);
      lines.push(`**Cost:** $${usage.totalCostUsd.toFixed(4)}`);
      lines.push(`**Turns:** ${usage.numTurns}`);
    }
  } else {
    lines.push('No active session. Use `/project <path>` to start.');
  }

  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}
