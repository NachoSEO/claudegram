import { ChatInputCommandInteraction, AttachmentBuilder } from 'discord.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../config.js';
import { transcribeFile } from '../../audio/transcribe.js';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';

const FILE_THRESHOLD_CHARS = 2000;

export async function handleTranscribe(interaction: ChatInputCommandInteraction): Promise<void> {
  const attachment = interaction.options.getAttachment('file', true);

  if (!attachment.contentType?.startsWith('audio/') && !attachment.contentType?.startsWith('video/')) {
    await interaction.reply({ content: 'Please provide an audio or video file.', ephemeral: true });
    return;
  }

  if (!config.GROQ_API_KEY) {
    await interaction.reply({ content: 'Transcription not configured. Set GROQ_API_KEY in .env.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  let tempFilePath: string | null = null;

  try {
    // Determine extension
    const ext = attachment.name?.match(/\.\w+$/)?.[0] || '.ogg';
    tempFilePath = path.join(os.tmpdir(), `claudegram_transcribe_${interaction.id}${ext}`);

    // Download
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

    const fileSize = fs.statSync(tempFilePath).size;
    if (!fileSize) throw new Error('Downloaded empty file.');

    console.log(`[Discord Transcribe] Downloaded ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

    // Transcribe
    const transcript = await transcribeFile(tempFilePath);

    if (!transcript) {
      await interaction.editReply('No speech detected in the audio.');
      return;
    }

    // Output
    if (transcript.length <= FILE_THRESHOLD_CHARS) {
      await interaction.editReply(`🎤 **Transcript:**\n\n${transcript}`);
    } else {
      // Long transcript — send as .txt file
      const txtBuffer = Buffer.from(transcript, 'utf-8');
      const file = new AttachmentBuilder(txtBuffer, { name: 'transcript.txt' });
      await interaction.editReply({
        content: `🎤 **Transcript** (${transcript.length.toLocaleString()} chars) — see attached file.`,
        files: [file],
      });
    }
  } catch (error) {
    const msg = sanitizeError(error);
    console.error('[Discord Transcribe] Error:', msg);
    await interaction.editReply(`Error: ${msg}`).catch(() => {});
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Discord Transcribe] Cleaned up ${sanitizePath(tempFilePath)}`);
      } catch { /* ignore */ }
    }
  }
}
