import { ChatInputCommandInteraction } from 'discord.js';
import { jobRunner } from '../../jobs/index.js';

export async function handleJobs(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = interaction.options.getString('state', false) ?? undefined;
  const limit = interaction.options.getInteger('limit', false) ?? 10;

  const recent = jobRunner.listRecent(Math.min(Math.max(limit, 1), 25));
  const filtered = state ? recent.filter((j) => j.state === state) : recent;

  if (!filtered.length) {
    await interaction.reply({ content: 'No jobs found for that filter.', ephemeral: true });
    return;
  }

  const lines = filtered.map((j) => {
    const runtimeMs = (j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt);
    const where = j.origin.threadId ? `thread:${j.origin.threadId}` : `channel:${j.origin.channelId}`;
    return `- \`${j.jobId}\` • **${j.name}** • ${j.state} • ${Math.round(runtimeMs / 1000)}s • ${where}`;
  });

  await interaction.reply({
    ephemeral: true,
    content: [`**Jobs**${state ? ` (state: ${state})` : ''}`, ...lines].join('\n'),
  });
}
