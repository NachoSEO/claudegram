import {
  ChatInputCommandInteraction,
  TextChannel,
} from 'discord.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execDroidStream, type DroidStreamEvent } from '../../droid/droid-bridge.js';
import { transcribeFile } from '../../audio/transcribe.js';
import { maybeSendDiscordVoiceReplyToChannel } from '../voice-reply.js';
import { config } from '../../config.js';

const STREAM_UPDATE_INTERVAL_MS = 1500;
const DROID_TIMEOUT_MS = 5 * 60 * 1000;
const DISCORD_MSG_LIMIT = 2000;

/** Split text into chunks respecting Discord's 2000-char limit */
function chunkText(text: string, limit = DISCORD_MSG_LIMIT - 50): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

export async function handleDroid(interaction: ChatInputCommandInteraction): Promise<void> {
  let prompt = interaction.options.getString('prompt') || '';
  const model = interaction.options.getString('model') || undefined;
  const autoRaw = interaction.options.getString('auto') || 'low';
  const auto: 'low' | 'medium' | 'high' = ['low', 'medium', 'high'].includes(autoRaw) ? autoRaw as 'low' | 'medium' | 'high' : 'low';
  const spec = interaction.options.getString('spec') || undefined;
  const audioAttachment = interaction.options.getAttachment('audio');

  await interaction.deferReply();

  // ── STT: transcribe audio attachment if provided ───────────────────
  let tempFilePath: string | null = null;
  if (audioAttachment) {
    if (!config.GROQ_API_KEY) {
      await interaction.editReply('Voice transcription not configured. Set GROQ_API_KEY in .env.');
      return;
    }

    if (!audioAttachment.contentType?.startsWith('audio/') && !audioAttachment.contentType?.startsWith('video/')) {
      await interaction.editReply('Please provide an audio or video file.');
      return;
    }

    try {
      const ext = audioAttachment.contentType?.includes('ogg') ? '.ogg'
        : audioAttachment.contentType?.includes('webm') ? '.webm'
        : audioAttachment.contentType?.includes('mp4') ? '.mp4'
        : '.ogg';

      tempFilePath = path.join(os.tmpdir(), `claudegram_droid_voice_${interaction.id}${ext}`);
      const response = await fetch(audioAttachment.url);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

      console.log(`[Droid] Transcribing audio (${(fs.statSync(tempFilePath).size / 1024).toFixed(0)}KB)`);
      const transcript = await transcribeFile(tempFilePath);

      if (!transcript) {
        await interaction.editReply('No speech detected in the audio.');
        return;
      }

      prompt = prompt ? `${prompt}\n\n[Voice message transcript]: ${transcript}` : transcript;
      console.log(`[Droid] Transcribed: ${transcript.slice(0, 100)}...`);
    } catch (err: any) {
      await interaction.editReply(`Transcription failed: ${err.message}`);
      return;
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
      }
    }
  }

  if (!prompt) {
    await interaction.editReply('Provide a prompt or attach an audio message.');
    return;
  }

  const channel = interaction.channel;
  if (!channel || !('threads' in channel)) {
    await interaction.editReply('Cannot create a thread in this channel type.');
    return;
  }

  // Create a thread for the droid output
  const threadTitle = `🤖 ${prompt.slice(0, 90)}`;
  const thread = await (channel as TextChannel).threads.create({
    name: threadTitle,
    autoArchiveDuration: 1440,
  });

  const transcriptNote = audioAttachment ? '\n🎤 *Transcribed from voice*' : '';
  await interaction.editReply(`Droid running in thread: ${thread.toString()}${transcriptNote}`);

  // Post initial status as plain text
  const statusMsg = await thread.send(`**🤖 Factory Droid** — Starting...\n**Task:** ${prompt.slice(0, 500)}`);

  // Track streaming state
  const toolCalls: string[] = [];
  let lastContent = '';
  let sessionId: string | undefined;
  let lastUpdateTime = 0;

  try {
    console.log(`[Droid] Starting stream for prompt: ${prompt.slice(0, 80)}...`);
    const stream = execDroidStream(prompt, {
      model,
      auto,
      useSpec: spec,
      timeoutMs: DROID_TIMEOUT_MS,
    });

    for await (const event of stream) {
      const now = Date.now();
      console.log(`[Droid] Event: ${event.type}`);

      switch (event.type) {
        case 'system': {
          const sid = event.data?.session_id;
          if (sid) sessionId = sid;
          console.log(`[Droid] Session: ${sid}, model: ${event.data?.model}`);
          break;
        }

        case 'tool_call': {
          const toolName = event.data?.toolName ?? event.data?.tool ?? event.data?.name ?? 'unknown';
          toolCalls.push(toolName);

          if (now - lastUpdateTime > STREAM_UPDATE_INTERVAL_MS) {
            lastUpdateTime = now;
            await statusMsg.edit(
              `**🤖 Factory Droid** — Working...\n🔧 \`${toolName}\` (${toolCalls.length} tool calls)`
            ).catch(() => {});
          }
          break;
        }

        case 'message': {
          const content = event.data?.content ?? event.data?.text ?? '';
          if (content) {
            lastContent = content;
            console.log(`[Droid] Message: ${content.slice(0, 80)}...`);
          }
          break;
        }

        case 'completion':
        case 'result': {
          lastContent = event.data?.result ?? event.data?.finalText ?? lastContent;
          sessionId = event.data?.session_id ?? event.data?.sessionId ?? sessionId;
          console.log(`[Droid] Completed — ${lastContent.length} chars, session ${sessionId?.slice(0, 8)}`);
          break;
        }

        case 'error': {
          const errMsg = event.data?.message ?? event.data?.error ?? 'Unknown error';
          await statusMsg.edit(`**🤖 Factory Droid** — Error\n\n${String(errMsg).slice(0, 1500)}`).catch(() => {});
          console.error(`[Droid] Error event: ${errMsg}`);
          return;
        }
      }
    }

    // Stream finished — post the final result as plain markdown
    if (!lastContent) {
      lastContent = '(No output returned)';
      console.warn('[Droid] Stream ended with no content');
    }

    // Update status message with summary
    const footer = [
      `${toolCalls.length} tool calls`,
      sessionId ? `session \`${sessionId.slice(0, 12)}\`` : null,
    ].filter(Boolean).join(' · ');

    await statusMsg.edit(`**🤖 Factory Droid** — Complete ✅\n${footer}`).catch(() => {});

    // Post the full result as regular markdown, chunked for Discord limits
    const chunks = chunkText(lastContent);
    for (const chunk of chunks) {
      await thread.send(chunk);
    }

    // ── TTS: send voice reply if user has TTS enabled ──────────────
    await maybeSendDiscordVoiceReplyToChannel(
      interaction.user.id,
      thread.id,
      lastContent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Droid] Stream error:', message);
    await statusMsg.edit(`**🤖 Factory Droid** — Error\n\n${message.slice(0, 1500)}`).catch(() => {});
  }
}
