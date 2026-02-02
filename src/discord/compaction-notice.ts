import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Send a Discord embed when the agent context was compacted.
 * Mirrors the Telegram `sendCompactionNotification`.
 */
export async function sendCompactionNotice(
  channel: any,
  compaction: { trigger: 'manual' | 'auto'; preTokens: number } | undefined,
): Promise<void> {
  if (!config.CONTEXT_NOTIFY_COMPACTION || !compaction) return;

  const isAuto = compaction.trigger === 'auto';
  const embed = new EmbedBuilder()
    .setColor(isAuto ? 0xFFA500 : 0x5865F2) // orange for auto, blurple for manual
    .setTitle(`${isAuto ? '⚠️' : 'ℹ️'} Context Compacted`)
    .setDescription(
      `**${isAuto ? 'Auto-compacted' : 'Manually compacted'}** — previous context was **${fmtTokens(compaction.preTokens)} tokens**.\n`
      + `The agent now has a summarized version of the conversation.\n\n`
      + `*Tip: Use \`/handoff\` before compaction to save a detailed context document.*`,
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Discord] Failed to send compaction notice:', err);
  }
}

/**
 * Send a Discord embed when a new agent session starts (session ID changed).
 * Mirrors the Telegram `sendSessionInitNotification`.
 */
export async function sendSessionInitNotice(
  channel: any,
  chatId: number,
  sessionInit: { model: string; sessionId: string } | undefined,
): Promise<void> {
  if (!config.CONTEXT_NOTIFY_COMPACTION || !sessionInit) return;

  const previousSessionId = sessionManager.getSession(chatId)?.claudeSessionId;
  if (!previousSessionId || sessionInit.sessionId === previousSessionId) return;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔄 New Agent Session')
    .setDescription(
      `A new agent session has started (previous context may be summarized).\n`
      + `Model: \`${sessionInit.model}\`\n\n`
      + `*The agent may not remember earlier details. Consider sharing context.*`,
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Discord] Failed to send session init notice:', err);
  }
}
