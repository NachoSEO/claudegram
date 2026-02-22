import {
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { jobRunner } from '../../jobs/index.js';
import { npmBuildV2, type NpmBuildV2Payload } from '../../jobs/workers/npm-build-v2.js';
import { postJobStarted } from '../jobs/job-notifier.js';

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
  .addSubcommand((sub) => sub.setName('status').setDescription('Show last job status (coming soon)'));

export async function devopsCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await interaction.reply({ content: 'Use /devops run job:build. (status UI coming soon)', ephemeral: true });
    return;
  }

  const jobName = interaction.options.getString('job', true);
  if (jobName !== 'build') {
    await interaction.reply({ content: `Unknown job: ${jobName}`, ephemeral: true });
    return;
  }

  const repoPath = repoPathFromEnvOrCwd();
  const payload: NpmBuildV2Payload = { repoPath };

  const jobId = jobRunner.enqueue({
    name: `devops:${jobName}`,
    origin: {
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      threadId: interaction.channel?.isThread() ? interaction.channelId : undefined,
      userId: interaction.user.id,
    },
    handler: npmBuildV2(payload),
    timeoutMs: 1000 * 60 * 10,
  });

  await postJobStarted(interaction, jobId);
}

export async function devopsButton(_interaction: ButtonInteraction) {
  // handled by generic job buttons now
}
