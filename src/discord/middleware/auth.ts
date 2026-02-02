import { Interaction, GuildMember, Message } from 'discord.js';
import { discordConfig } from '../discord-config.js';

/**
 * Check if a Discord user is authorized to use the bot.
 * Checks user ID against allowlist, then optionally checks role IDs.
 */
export function isAuthorizedUser(userId: string, member?: GuildMember | null): boolean {
  // Check user ID allowlist
  if (discordConfig.DISCORD_ALLOWED_USER_IDS.includes(userId)) {
    return true;
  }

  // Check role-based access if configured
  if (discordConfig.DISCORD_ALLOWED_ROLE_IDS.length > 0 && member) {
    for (const roleId of discordConfig.DISCORD_ALLOWED_ROLE_IDS) {
      if (member.roles.cache.has(roleId)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check authorization for a slash command interaction.
 * Returns true if authorized, false if not (and sends ephemeral rejection).
 */
export async function checkInteractionAuth(interaction: Interaction): Promise<boolean> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember | null;

  if (isAuthorizedUser(userId, member)) {
    return true;
  }

  if (interaction.isRepliable()) {
    await interaction.reply({
      content: 'You are not authorized to use this bot.',
      ephemeral: true,
    });
  }

  console.log(`[Discord] Rejected: Unauthorized user ${userId} (${interaction.user.tag})`);
  return false;
}

/**
 * Check authorization for a thread message.
 */
export function isAuthorizedMessage(message: Message): boolean {
  const userId = message.author.id;
  const member = message.member;
  return isAuthorizedUser(userId, member);
}
