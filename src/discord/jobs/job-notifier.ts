import { ButtonInteraction, ChatInputCommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionReplyOptions, Message, TextBasedChannel } from 'discord.js';
import { jobRunner } from '../../jobs';
import { JobEvent, JobSnapshot } from '../../jobs/core/job-types';
import { splitDiscordMessage } from '../markdown.js';

function fmtState(s: JobSnapshot['state']) {
  if (s === 'succeeded') return '✅ succeeded';
  if (s === 'failed') return '❌ failed';
  if (s === 'canceled') return '🛑 canceled';
  if (s === 'timeout') return '⏱️ timeout';
  if (s === 'running') return '⏳ running';
  return '📥 queued';
}

export function jobActionRow(jobId: string, canCancel: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`job:logs:${jobId}`).setLabel('Show logs').setStyle(ButtonStyle.Secondary),
  );
  if (canCancel) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`job:cancel:${jobId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
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
    if (s) {
      s.origin.statusMessageId = (reply as any).id;
    }
  }
}

// Debounced edits by jobId
const editTimers = new Map<string, NodeJS.Timeout>();

export function attachJobNotifier(client: any) {
  jobRunner.onEvent(async (ev: JobEvent) => {
    const snap = jobRunner.get(ev.jobId);
    if (!snap?.origin?.channelId || !snap.origin.statusMessageId) return;

    // debounce status edits
    if (editTimers.has(ev.jobId)) return;
    editTimers.set(
      ev.jobId,
      setTimeout(async () => {
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
            components: [jobActionRow(snap.jobId, snap.state === 'queued' || snap.state === 'running')],
          });
        } catch {
          // ignore
        }
      }, 1250),
    );
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
}
