import { createDiscordBot } from './discord/discord-bot.js';
import { registerCommands } from './discord/commands/register.js';
import { discordConfig } from './discord/discord-config.js';
import { disconnectAll } from './discord/voice-channel/voice-connection.js';

async function main() {
  console.log('Starting Claudegram Discord bot...');
  console.log(`Allowed users: ${discordConfig.DISCORD_ALLOWED_USER_IDS.join(', ')}`);

  // Register slash commands
  await registerCommands();

  // Create and start the bot
  const client = createDiscordBot();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down Discord bot...');

    // Gracefully disconnect all voice sessions first (closes Gemini, kills ffmpeg cleanly)
    await disconnectAll();

    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  await client.login(discordConfig.DISCORD_BOT_TOKEN);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
