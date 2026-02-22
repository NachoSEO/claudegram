import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { jobManager } from '../../jobs/index.js';
import { npmBuild, type NpmBuildPayload } from '../../jobs/workers/npm-build.js';
import { splitDiscordMessage } from '../markdown.js';

function repoPathFromEnvOrCwd() {
  return process.env.CLAUDEGRAM_REPO_PATH || process.cwd();
}

export const devopsSlash = new SlashCommandBuilder()
  .setName('devops')
  .setDescription('Run background DevOps jobs (build, typecheck, etc.)')
  .addSubcommand((sub) =>
    sub
      .setName('run')
      .setDescription('Run a devops job')
      .addStringOption((opt) =>
        opt
          .setName('job')
          .setDescription('Job to run')
          .setRequired(true)
          .addChoices({ name: 'build', value: 'build' }),
      ),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Show last job status'));

export async function devopsCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await interaction.reply({ content: 'No persisted status yet (v1). Use /devops run job:build.', ephemeral: true });
    return;
  }

  const jobName = interaction.options.getString('job', true);
  if (jobName !== 'build') {
    await interaction.reply({ content: `Unknown job: ${jobName}`, ephemeral: true });
    return;
  }

  const repoPath = repoPathFromEnvOrCwd();
  const payload: NpmBuildPayload = { repoPath };
  const job = jobManager.create('npm-build', payload, npmBuild);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`devops:cancel:${job.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`devops:logs:${job.id}`).setLabel('Show logs').setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    content: `Started DevOps job \`${jobName}\` (job \`${job.id}\`) in repo: \`${repoPath}\`.`,
    components: [row],
  });

  const interval = setInterval(async () => {
    const j = jobManager.get(job.id);
    if (!j) return;
    if (j.state === 'queued' || j.state === 'running') return;
    clearInterval(interval);

    const ms = (j.finishedAt ?? Date.now()) - (j.startedAt ?? j.createdAt);
    const secs = (ms / 1000).toFixed(1);
    const status = j.state === 'succeeded'
      ? '✅ Done'
      : j.state === 'cancelled'
        ? '🛑 Cancelled'
        : '❌ Failed';

    try {
      await interaction.editReply({
        content: `${status} — DevOps job \`${jobName}\` (job \`${job.id}\`) finished in ${secs}s.`,
        components: [row],
      });
    } catch {
      // ignore
    }
  }, 1500);
}

export async function devopsButton(interaction: ButtonInteraction) {
  const [prefix, action, jobId] = String(interaction.customId).split(':');
  if (prefix !== 'devops' || !action || !jobId) return;

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

  if (action === 'logs') {
    if (job.state === 'queued' || job.state === 'running') {
      await interaction.reply({ content: `Job \`${jobId}\` is ${job.state}...`, ephemeral: true });
      return;
    }

    if (job.state === 'failed') {
      const chunks = splitDiscordMessage(`Job failed:\n\n${job.error ?? '(no error)'}\n`, 1900);
      await interaction.reply({ content: chunks[0], ephemeral: true });
      for (const c of chunks.slice(1)) await interaction.followUp({ content: c, ephemeral: true });
      return;
    }

    const res: any = job.result;
    const steps = res?.steps ?? [];
    const out = steps.map((s: any) => {
      const head = `## ${s.name} (exit: ${s.exitCode})\nCommand: ${s.command}`;
      const body = `\n\nSTDOUT:\n${s.stdout || ''}\n\nSTDERR:\n${s.stderr || ''}`;
      return head + body;
    }).join('\n\n---\n\n');

    const chunks = splitDiscordMessage(out || '(no logs)', 1900);
    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (const c of chunks.slice(1)) await interaction.followUp({ content: c, ephemeral: true });
  }
}
