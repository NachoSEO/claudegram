import { ChatInputCommandInteraction } from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { sessionManager } from '../../claude/session-manager.js';
import { getModel, getCachedUsage, isDangerousMode } from '../../claude/agent.js';
import { isProcessing } from '../../claude/request-queue.js';
import { config } from '../../config.js';

/**
 * Sends a concise status summary of the bot and the user's current session to the invoking Discord interaction.
 *
 * The reply includes the project path, active model, processing state, dangerous mode flag, optional Claude session ID,
 * and—when available—usage metrics (total/context tokens with percentage, cost, and turns). If no session exists, a
 * short instruction for starting a project is returned. The reply is sent as an ephemeral message to the command caller.
 *
 * @param interaction - The Discord ChatInputCommandInteraction that triggered the status command
 */
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
    lines.push(`**Provider:** ${config.AGENT_PROVIDER}`);
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