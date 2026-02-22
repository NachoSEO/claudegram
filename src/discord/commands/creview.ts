import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { JobManager } from '../../jobs/job-manager.js';
import {
  coderabbitReview,
  type CodeRabbitPayload,
} from '../../jobs/workers/coderabbit-review.js';
import { splitDiscordMessage } from '../markdown.js';

const jobManager = new JobManager(1);

function repoPathFromCwd() {
  return process.cwd();
}

export async function creviewCommand(interaction: ChatInputCommandInteraction) {
  const baseRef = interaction.options.getString('base') ?? 'origin/main';
  const target = (interaction.options.getString('target') as 'committed' | 'uncommitted') ?? 'committed';

  const payload: CodeRabbitPayload = {
    repoPath: repoPathFromCwd(),
    baseRef,
    target,
    promptOnly: true,
  };

  const job = jobManager.create('coderabbit-review', payload, coderabbitReview);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creview:cancel:${job.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`creview:show:${job.id}`)
      .setLabel('Show output')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    content: `Started CodeRabbit review (job \`${job.id}\`) vs \`${baseRef}\` (target: \`${target}\`).`,
    components: [row],
  });
}

export async function creviewButton(interaction: any) {
  const [prefix, action, jobId] = String(interaction.customId).split(':');
  if (prefix !== 'creview' || !action || !jobId) return;

  const job = jobManager.get(jobId);
  if (!job) {
    await interaction.reply({ content: `Job not found: \`${jobId}\``, ephemeral: true });
    return;
  }

  if (action === 'cancel') {
    const ok = jobManager.cancel(jobId);
    await interaction.reply({
      content: ok ? `Cancelled job \`${jobId}\`.` : `Can't cancel job \`${jobId}\` (state: ${job.state}).`,
      ephemeral: true,
    });
    return;
  }

  if (action === 'show') {
    if (job.state === 'queued' || job.state === 'running') {
      await interaction.reply({ content: `Job \`${jobId}\` is ${job.state}...`, ephemeral: true });
      return;
    }

    if (job.state === 'failed') {
      const chunks = splitDiscordMessage(`CodeRabbit failed:\n\n${job.error ?? '(no error)'}\n`, 1900);
      await interaction.reply({ content: chunks[0], ephemeral: true });
      for (const c of chunks.slice(1)) await interaction.followUp({ content: c, ephemeral: true });
      return;
    }

    const res: any = job.result;
    const out = [
      `Command: ${res?.command ?? ''}`,
      `Exit: ${res?.exitCode ?? ''}`,
      '',
      'STDOUT:',
      res?.stdout ?? '',
      '',
      'STDERR:',
      res?.stderr ?? '',
    ].join('\n');

    const chunks = splitDiscordMessage(out, 1900);
    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (const c of chunks.slice(1)) await interaction.followUp({ content: c, ephemeral: true });
  }
}
