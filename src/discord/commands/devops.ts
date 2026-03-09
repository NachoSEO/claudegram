import crypto from 'node:crypto';
import {
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { jobRunner } from '../../jobs/index.js';
import { npmBuildV2, type NpmBuildV2Payload } from '../../jobs/workers/npm-build-v2.js';
import {
  fullSelfRefreshJob,
  restartDiscordServiceJob,
  selfCheckJob,
  selfUpdateJob,
} from '../../jobs/workers/devops-maintenance.js';
import { agentDeepLoopJob, type AgentDeepLoopPayload } from '../../jobs/workers/agent-deep-loop.js';
import { postJobStarted } from '../jobs/job-notifier.js';
import { approvalManager } from '../approvals/index.js';
import { getApprovalDecision } from '../../jobs/core/approval-policy.js';
import { jobNotificationOutbox } from '../jobs/job-notification-outbox.js';
import { delegatedSessionId, discordSessionId } from '../id-mapper.js';

function repoPathFromEnvOrCwd() {
  return process.env.CLAUDEGRAM_REPO_PATH || process.cwd();
}

function makeIdempotencyKey(
  name: string,
  origin: { channelId: string; userId: string; threadId?: string },
  payload: unknown,
): string {
  const raw = JSON.stringify({ name, channelId: origin.channelId, userId: origin.userId, threadId: origin.threadId, payload });
  return crypto.createHash('sha256').update(raw).digest('hex');
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
          .addChoices(
            { name: 'build', value: 'build' },
            { name: 'self-check', value: 'self-check' },
            { name: 'self-update', value: 'self-update' },
            { name: 'restart-discord-service', value: 'restart-discord-service' },
            { name: 'full-self-refresh', value: 'full-self-refresh' },
            { name: 'agent-loop-30m', value: 'agent-loop-30m' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('deep')
      .setDescription('Run a 30m agent deep loop and report back')
      .addStringOption((opt) => opt.setName('task').setDescription('Deep task prompt').setRequired(true))
      .addStringOption((opt) => opt.setName('model').setDescription('Optional model override').setRequired(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show background job status')
      .addStringOption((opt) => opt.setName('job_id').setDescription('Optional job ID').setRequired(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a queued/running background job')
      .addStringOption((opt) => opt.setName('job_id').setDescription('Job ID to cancel').setRequired(true)),
  );

export async function devopsCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const jobId = interaction.options.getString('job_id', false) ?? undefined;
    if (jobId) {
      const j = jobRunner.get(jobId);
      if (!j) {
        await interaction.reply({ content: `Job not found: \`${jobId}\``, flags: 64 });
        return;
      }
      const durationMs = (j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt);
      const recentLogs = j.logs.slice(-8).map((l) => `- ${new Date(l.at).toISOString()} [${l.level}] ${l.message.slice(0, 180)}`);
      const failedOutbox = jobNotificationOutbox.getFailed();
        await interaction.reply({
          content: [
            `**Job \`${j.jobId}\`**`,
            `- **Name**: ${j.name}`,
            `- **State**: ${j.state}`,
            `- **Parent Job**: ${j.parentJobId ?? 'none'}`,
            `- **Root Job**: ${j.rootJobId}`,
            `- **Child Jobs**: ${j.childJobIds.length}`,
            `- **Duration**: ${Math.round(durationMs / 1000)}s`,
            `- **Exit Code**: ${j.exitCode ?? 'n/a'}`,
            j.error ? `- **Error**: \`${j.error.slice(0, 300)}\`` : null,
          failedOutbox.length ? `- **Notification Outbox Failed**: ${failedOutbox.length}` : null,
          recentLogs.length ? `\n**Recent Logs**\n${recentLogs.join('\n')}` : null,
        ].filter(Boolean).join('\n'),
        flags: 64,
      });
      return;
    }

    const recent = jobRunner.listRecent(8);
    if (!recent.length) {
      await interaction.reply({ content: 'No recent jobs found.', flags: 64 });
      return;
    }
      const lines = recent.map((j) => {
        const durationMs = (j.endedAt ?? Date.now()) - (j.startedAt ?? j.createdAt);
        const lineage = j.parentJobId ? ` • parent:\`${j.parentJobId.slice(0, 8)}\`` : '';
        const children = j.childJobIds.length ? ` • children:${j.childJobIds.length}` : '';
        return `- \`${j.jobId}\` • **${j.name}** • ${j.state} • ${Math.round(durationMs / 1000)}s${lineage}${children}`;
      });
    const m = jobRunner.getMetrics();
    const failedOutbox = jobNotificationOutbox.getFailed();
    const degradedFlags: string[] = [];
    if (failedOutbox.length > 0) degradedFlags.push(`outbox_failed=${failedOutbox.length}`);
    if (m.totalTimeout > 0) degradedFlags.push(`timeouts=${m.totalTimeout}`);

    const metricsBlock = [
      '**Health**',
      `- queue_depth=${m.queueDepth} running=${m.running ? 1 : 0} peak_queue=${m.peakQueueDepth}`,
      `- totals queued=${m.totalQueued} started=${m.totalStarted} ended=${m.totalEnded} ok=${m.totalSucceeded} failed=${m.totalFailed} canceled=${m.totalCanceled} timeout=${m.totalTimeout}`,
      `- latency wait_p95=${Math.round(m.waitP95Ms)}ms run_p95=${Math.round(m.runP95Ms)}ms`,
      degradedFlags.length ? `- degraded: ${degradedFlags.join(', ')}` : '- degraded: none',
    ].join('\n');

    await interaction.reply({ content: `**Recent Jobs**\n${lines.join('\n')}\n\n${metricsBlock}`, flags: 64 });
    return;
  }

  if (sub === 'cancel') {
    const jobId = interaction.options.getString('job_id', true);
    const ok = jobRunner.cancel(jobId);
    await interaction.reply({
      content: ok ? `Cancel requested for job \`${jobId}\`.` : `Unable to cancel job \`${jobId}\` (not queued/running).`,
      flags: 64,
    });
    return;
  }

  let jobName = interaction.options.getString('job', false) || '';
  let deepTask = '';
  let deepModel: string | undefined;
  if (sub === 'deep') {
    jobName = 'agent-loop-30m';
    deepTask = interaction.options.getString('task', true);
    deepModel = interaction.options.getString('model', false) ?? undefined;
  }

  const known = new Set([
    'build',
    'self-check',
    'self-update',
    'restart-discord-service',
    'full-self-refresh',
    'agent-loop-30m',
  ]);
  if (!known.has(jobName)) {
    await interaction.reply({ content: `Unknown job: ${jobName}`, flags: 64 });
    return;
  }

  const repoPath = repoPathFromEnvOrCwd();

  let handler;
  if (jobName === 'build') {
    const payload: NpmBuildV2Payload = { repoPath };
    handler = npmBuildV2(payload);
  } else if (jobName === 'self-check') {
    handler = selfCheckJob(repoPath);
  } else if (jobName === 'self-update') {
    handler = selfUpdateJob(repoPath);
  } else if (jobName === 'restart-discord-service') {
    handler = restartDiscordServiceJob();
  } else if (jobName === 'full-self-refresh') {
    handler = fullSelfRefreshJob(repoPath);
    } else {
      const parentChatId = discordSessionId(interaction.user.id, interaction.channelId);
      const childChatId = delegatedSessionId(`${parentChatId}:${jobName}:${Date.now()}`);
      const payload: AgentDeepLoopPayload = {
        userId: interaction.user.id,
        parentChatId,
        childChatId,
        task:
          deepTask ||
          'Run a 30 minute deep implementation/research loop and return a concise report with findings, diffs, and next actions.',
        model: deepModel || 'gpt-5.3-codex-spark',
      };
      handler = agentDeepLoopJob(payload);
    }

  const origin = {
    guildId: interaction.guildId ?? undefined,
    channelId: interaction.channelId,
    threadId: interaction.channel?.isThread() ? interaction.channelId : undefined,
    userId: interaction.user.id,
  };
  const timeoutMs = jobName === 'agent-loop-30m' ? 1000 * 60 * 30 : 1000 * 60 * 15;
  const fullJobName = `devops:${jobName}`;
  const decision = getApprovalDecision(fullJobName, timeoutMs);

  if (decision.requiresApproval) {
    const approval = approvalManager.create({
      summary: `Approve ${fullJobName}? (tier ${decision.tier})`,
      details: `Reason: ${decision.reason}`,
      requestedByUserId: interaction.user.id,
      channelId: interaction.channelId,
      threadId: interaction.channel?.isThread() ? interaction.channelId : undefined,
    });

    await interaction.reply({
      flags: 64,
      content: `Approval required for **${fullJobName}**.\n${decision.reason}`,
      components: [approvalManager.renderButtons(approval.id)],
    });

    const decided = await approvalManager.awaitDecision(approval.id);
    if (decided.state !== 'approved') {
      await interaction.followUp({ flags: 64, content: `Job not queued. Approval state: **${decided.state}**.` });
      return;
    }
  }

  const idempotencyKey = makeIdempotencyKey(fullJobName, origin, {
    repoPath,
    deepTask: deepTask ?? null,
    deepModel: deepModel ?? null,
  });

  const jobId = jobRunner.enqueue({
    name: fullJobName,
    lane: jobName === 'agent-loop-30m' ? 'subagent' : 'maintenance',
    origin,
    handler,
    timeoutMs,
    idempotencyKey,
  });

  await postJobStarted(interaction, jobId);
}

export async function devopsButton(_interaction: ButtonInteraction) {
  // handled by generic job buttons now
}
