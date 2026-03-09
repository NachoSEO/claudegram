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

function renderCompletionAnnouncement(snap: JobSnapshot): string {
  const lines = [
    `## Child agent ${fmtState(snap.state)}`,
    `- **Job**: \`${snap.jobId}\``,
    `- **Name**: ${snap.name}`,
    `- **Lane**: ${snap.lane}`,
  ];

  if (snap.parentJobId) {
    lines.push(`- **Parent Job**: \`${snap.parentJobId}\``);
  }
  if (snap.resultSummary) {
    lines.push('', '### Result', snap.resultSummary);
  }
  if (snap.artifacts?.length) {
    lines.push('', '### Metadata', ...snap.artifacts.map((item) => `- ${item}`));
  }
  if (snap.error) {
    lines.push('', '### Error', `\`\`\`\n${String(snap.error).slice(0, 1800)}\n\`\`\``);
  }

  return lines.join('\n');
}

export function jobActionRow(jobId: string, canCancel: boolean, canRetry = false, canShowResult = false) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`job:logs:${jobId}`).setLabel('Show logs').setStyle(ButtonStyle.Secondary),
  );
  if (canShowResult) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`job:result:${jobId}`).setLabel('Show result').setStyle(ButtonStyle.Success),
    );
  }
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
    components: [jobActionRow(jobId, true, false, false)],
  };
  await interaction.reply(opts);

  try {
    const reply = await interaction.fetchReply();
    const replyId = reply && typeof (reply as any).id === 'string' ? String((reply as any).id) : null;
    if (replyId) {
      const s = jobRunner.get(jobId);
      if (s?.origin) {
        jobRunner.updateOrigin(jobId, { ...s.origin, statusMessageId: replyId });
      }
    }
  } catch {
    // non-fatal: status message can still be tracked via /jobs and /devops status
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
          if (!ch) {
            jobNotificationOutbox.markAttemptFailure(item.key, 'channel_unavailable');
            continue;
          }
          if (!('send' in ch)) {
            jobNotificationOutbox.markAttemptFailure(item.key, 'channel_send_unsupported');
            continue;
          }

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
          jobNotificationOutbox.markAttemptSuccess(item.key);
        } catch (e) {
          jobNotificationOutbox.markAttemptFailure(item.key, e instanceof Error ? e.message : String(e));
        }
      }

      if (jobNotificationOutbox.getPending().length > 0) scheduleDeferredDispatch();
    }, 5000);
  };

  // Flush any persisted pending notifications after restart
  scheduleDeferredDispatch();

    jobRunner.onEvent(async (ev: JobEvent) => {
      const snap = jobRunner.get(ev.jobId);

      if (ev.type === 'job:end' && snap) {
        if (snap.parentJobId) {
          try {
            const ch = await client.channels.fetch(snap.origin.threadId ?? snap.origin.channelId);
            if (ch && 'send' in ch) {
              const chunks = splitDiscordMessage(renderCompletionAnnouncement(snap), 1800);
              for (const chunk of chunks) {
                await (ch as any).send({ content: chunk });
              }
              return;
            }
          } catch {
            // Fall back to outbox delivery below if direct announce fails.
          }
        }
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
            Boolean(snap.resultSummary || (snap.artifacts && snap.artifacts.length)),
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
  const parts = String(i.customId || '').split(':');
  const action = parts[1];
  const jobId = parts[2];
  if (!action || !jobId) {
    return i.reply({ flags: 64, content: 'Invalid job action payload.' });
  }

  const snap = jobRunner.get(jobId);
  if (!snap) return i.reply({ flags: 64, content: `Unknown job: ${jobId}` });

  if (action === 'cancel') {
    jobRunner.cancel(jobId);
    return i.reply({ flags: 64, content: `Cancel requested for job \`${jobId}\`.` });
  }

  if (action === 'logs') {
    const lines = snap.logs.map((l) => `[${new Date(l.at).toISOString()}] ${l.level.toUpperCase()}: ${l.message}`);
    const out = lines.length ? lines.join('\n') : '(no logs)';
    const chunks = splitDiscordMessage(out, 1800);
    await i.reply({ flags: 64, content: `Logs for \`${jobId}\` (${snap.name})` });
    for (const c of chunks) await i.followUp({ flags: 64, content: '```\n' + c + '\n```' });
    return;
  }

  if (action === 'result') {
    const parts: string[] = [];
    if (snap.resultSummary) parts.push(`Summary: ${snap.resultSummary}`);
    if (snap.artifacts?.length) {
      parts.push('Artifacts:');
      for (const a of snap.artifacts) parts.push(`- \`${a}\``);
    }
    if (!parts.length) parts.push('No structured result artifact available.');
    const chunks = splitDiscordMessage(parts.join('\n'), 1800);
    await i.reply({ flags: 64, content: chunks[0] });
    for (const c of chunks.slice(1)) await i.followUp({ flags: 64, content: c });
    return;
  }

  if (action === 'retry') {
    const nextId = jobRunner.retry(jobId);
    if (!nextId) return i.reply({ flags: 64, content: `Retry unavailable for job \`${jobId}\`.` });
    const next = jobRunner.get(nextId);
    return i.reply({
      flags: 64,
      content: `Retry queued: \`${nextId}\` for **${next?.name ?? 'job'}**.`,
      components: [jobActionRow(nextId, true, false, false)],
    });
  }
}
