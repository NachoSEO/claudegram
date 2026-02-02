import {
  REST,
  Routes,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
} from 'discord.js';
import { discordConfig } from '../discord-config.js';

const commands = [
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Send a message to Claude')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Your message to Claude')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel the current running request'),

  new SlashCommandBuilder()
    .setName('softreset')
    .setDescription('Clear the current session and start fresh'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and current session info'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear conversation history (keeps session)'),

  new SlashCommandBuilder()
    .setName('project')
    .setDescription('Set the working directory for Claude')
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Absolute path to the project directory')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Select the Claude model'),

  new SlashCommandBuilder()
    .setName('commands')
    .setDescription('List all available commands'),

  new ContextMenuCommandBuilder()
    .setName('Ask Claude')
    .setType(ApplicationCommandType.Message),
];

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(discordConfig.DISCORD_BOT_TOKEN);

  const commandData = commands.map(cmd => cmd.toJSON());

  try {
    if (discordConfig.DISCORD_GUILD_ID) {
      // Guild-scoped: instant update
      await rest.put(
        Routes.applicationGuildCommands(
          discordConfig.DISCORD_APPLICATION_ID,
          discordConfig.DISCORD_GUILD_ID
        ),
        { body: commandData },
      );
      console.log(`[Discord] Registered ${commandData.length} guild commands`);
    } else {
      // Global: may take up to an hour to propagate
      await rest.put(
        Routes.applicationCommands(discordConfig.DISCORD_APPLICATION_ID),
        { body: commandData },
      );
      console.log(`[Discord] Registered ${commandData.length} global commands`);
    }
  } catch (error) {
    console.error('[Discord] Failed to register commands:', error);
    throw error;
  }
}
