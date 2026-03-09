import { ChatInputCommandInteraction } from 'discord.js';
import { jobRunner } from '../../jobs/index.js';

export async function handleJobs(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = interaction.options.getString('state', false) ?? undefined;
  const limit = interaction.options.getInteger('limit', false) ?? 10;

  const recent = jobRunner.listRecent(Math.min(Math.max(limit, 1), 25));
  const filtered = state ? recent.filter((j) => j.state === state) : recent;

  if (!filtered.length) {
    await interaction.reply({ content: 'No jobs found for that filter.', flags: 64 });
    return;
  }

  const lines = filtered.map((j) => {
    const runtimeMs = (j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt);
    const where = j.origin?.threadId
      ? `thread:${j.origin.threadId}`
      : j.origin?.channelId
        ? `channel:${j.origin.channelId}`
        : 'route:unknown';
    const summary = j.resultSummary ? ` • ${j.resultSummary.slice(0, 90)}` : '';
    const lineage = j.parentJobId ? ` • parent:\`${j.parentJobId.slice(0, 8)}\`` : '';
    const children = j.childJobIds.length ? ` • children:${j.childJobIds.length}` : '';
    return `- \`${j.jobId}\` • **${j.name}** • lane:${j.lane} • ${j.state} • ${Math.round(runtimeMs / 1000)}s • ${where}${lineage}${children}${summary}`;
  });

  await interaction.reply({
    flags: 64,
    content: [`**Jobs**${state ? ` (state: ${state})` : ''}`, ...lines].join('\n'),
  });
}
