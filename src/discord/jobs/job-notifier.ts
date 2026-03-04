import { ButtonInteraction, ChatInputCommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionReplyOptions } from 'discord.js';
import { jobRunner } from '../../jobs/index.js';
import { JobEvent, JobSnapshot } from '../../jobs/core/job-types';
import { splitDiscordMessage } from '../markdown.js';
import { conversationActivityGate } from './activity-gate.js';
import { jobNotificationOutbox } from './job-notification-outbox.js';

function fmtState(s: JobSnapshot['state']) {
  if (s === 'succeeded') return '✅ succeeded';
  if (s === 'failed') return '❌ failed';
  if (s === 'canceled') return '🛑 canceled';
  if (s === 'timeout') return '⏱️ timeout';
  if (s === 'running') return '⏳ running';
  return '📥 queued';
}

export function jobActionRow(jobId: string, canCancel: boolean, canRetry = false) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`job:logs:${jobId}`).setLabel('Show logs').setStyle(ButtonStyle.Secondary),
  );
  if (canCancel) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`job:cancel:${jobId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );
  }
  if (canRetry) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`job:retry:${jobId}`).setLabel('Retry').setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

export async function postJobStarted(interaction: ChatInputCommandInteraction, jobId: string) {
  const snap = jobRunner.get(jobId);
  const msg = `Job started: **${snap?.name ?? jobId}**\nID: \`${jobId}\`\nState: ${fmtState(snap?.state ?? 'queued')}`;
  const opts: InteractionReplyOptions = {
    content: msg,
    components: [jobActionRow(jobId, true)],
  };
  await interaction.reply(opts);

  const reply = await interaction.fetchReply();
  if (reply && 'id' in reply) {
    const s = jobRunner.get(jobId);
    if (s) s.origin.statusMessageId = (reply as any).id;
  }
}

const editTimers = new Map<string, NodeJS.Timeout>();

export function attachJobNotifier(client: any) {
  let dispatchTimer: NodeJS.Timeout | null = null;

  const scheduleDeferredDispatch = () => {
    if (dispatchTimer) return;
    dispatchTimer = setTimeout(async () => {
      dispatchTimer = null;
      const pending = jobNotificationOutbox.getPending();

      for (const item of pending) {
        if (!item.critical) {
          const active = conversationActivityGate.isActive({
            guildId: item.guildId,
            channelId: item.channelId,
            threadId: item.threadId,
            userId: item.userId,
          });
          if (active) continue;
        }

        try {
          const ch = await client.channels.fetch(item.threadId ?? item.channelId);
          if (!ch || !('send' in ch)) continue;

          const jobs = item.jobs
            .slice(-5)
            .sort((a, b) => a.endedAt - b.endedAt)
            .map((j) => {
              const icon = j.state === 'succeeded' ? '✅' : j.state === 'failed' ? '❌' : j.state === 'timeout' ? '⏱️' : '🛑';
              const err = j.error ? ` — ${String(j.error).slice(0, 120)}` : '';
              return `- ${icon} **${j.name}** (\`${j.jobId}\`)${err}`;
            });

          const title = item.critical
            ? '🚨 Background job update (critical)'
            : item.jobs.length > 1
              ? '📦 Background jobs completed'
              : '✅ Background job completed';

          await (ch as any).send({ content: [title, ...jobs].join('\n') });
          jobNotificationOutbox.markSent(item.key);
        } catch {
          // keep pending; retry next cycle
        }
      }

      if (jobNotificationOutbox.getPending().length > 0) scheduleDeferredDispatch();
    }, 5000);
  };

  jobRunner.onEvent(async (ev: JobEvent) => {
    const snap = jobRunner.get(ev.jobId);

    if (ev.type === 'job:end' && snap) {
      jobNotificationOutbox.enqueueFromSnapshot(snap);
      scheduleDeferredDispatch();
    }

    if (!snap?.origin?.channelId || !snap.origin.statusMessageId) return;

    if (editTimers.has(ev.jobId)) return;
    const t = setTimeout(async () => {
      editTimers.delete(ev.jobId);
      try {
        const ch = await client.channels.fetch(snap.origin.threadId ?? snap.origin.channelId);
        if (!ch || !('messages' in ch)) return;
        const msg = await (ch as any).messages.fetch(snap.origin.statusMessageId);
        const runtimeMs = snap.startedAt ? (snap.endedAt ?? Date.now()) - snap.startedAt : 0;
        const line = snap.progress ? `\nProgress: ${snap.progress}` : '';
        const content = `Job: **${snap.name}**\nID: \`${snap.jobId}\`\nState: ${fmtState(snap.state)} (${Math.round(runtimeMs / 1000)}s)${line}`;
        await msg.edit({
          content,
          components: [jobActionRow(
            snap.jobId,
            snap.state === 'queued' || snap.state === 'running',
            snap.state === 'failed' || snap.state === 'timeout' || snap.state === 'canceled',
          )],
        });
      } catch {
        // ignore
      }
    }, 1250);
    editTimers.set(ev.jobId, t);
  });
}

export async function handleJobButton(i: ButtonInteraction) {
  const [_, action, jobId] = i.customId.split(':');
  const snap = jobRunner.get(jobId);
  if (!snap) return i.reply({ ephemeral: true, content: `Unknown job: ${jobId}` });

  if (action === 'cancel') {
    jobRunner.cancel(jobId);
    return i.reply({ ephemeral: true, content: `Cancel requested for job \`${jobId}\`.` });
  }

  if (action === 'logs') {
    const lines = snap.logs.map((l) => `[${new Date(l.at).toISOString()}] ${l.level.toUpperCase()}: ${l.message}`);
    const out = lines.length ? lines.join('\n') : '(no logs)';
    const chunks = splitDiscordMessage(out, 1800);
    await i.reply({ ephemeral: true, content: `Logs for \`${jobId}\` (${snap.name})` });
    for (const c of chunks) await i.followUp({ ephemeral: true, content: '```\n' + c + '\n```' });
    return;
  }

  if (action === 'retry') {
    const nextId = jobRunner.retry(jobId);
    if (!nextId) return i.reply({ ephemeral: true, content: `Retry unavailable for job \`${jobId}\`.` });
    const next = jobRunner.get(nextId);
    return i.reply({
      ephemeral: true,
      content: `Retry queued: \`${nextId}\` for **${next?.name ?? 'job'}**.`,
      components: [jobActionRow(nextId, true)],
    });
  }
}
