import { ChatInputCommandInteraction } from 'discord.js';

const COMMAND_LIST = [
  { name: '/chat', description: 'Send a message to Claude' },
  { name: '/cancel', description: 'Cancel the current running request' },
  { name: '/softreset', description: 'Clear session and start fresh' },
  { name: '/status', description: 'Show bot status and session info' },
  { name: '/clear', description: 'Clear conversation history (keeps session)' },
  { name: '/project', description: 'Set the working directory (dropdown if no path given)' },
  { name: '/model', description: 'Select the Claude model' },
  { name: '/commands', description: 'Show this list' },
  { name: 'Ask Claude', description: 'Right-click a message to analyze it (context menu)' },
];

export async function handleCommands(interaction: ChatInputCommandInteraction): Promise<void> {
  const lines = COMMAND_LIST.map(cmd => `\`${cmd.name}\` — ${cmd.description}`);

  await interaction.reply({
    content: `**Available Commands**\n\n${lines.join('\n')}\n\nYou can also @mention the bot in any channel to talk to Claude.`,
    ephemeral: true,
  });
}
