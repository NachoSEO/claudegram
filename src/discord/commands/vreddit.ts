import {
  ChatInputCommandInteraction,
  AttachmentBuilder,
} from 'discord.js';
import * as fs from 'fs';
import { downloadRedditVideo } from '../../reddit/vreddit.js';
import { discordConfig } from '../discord-config.js';

export async function handleVReddit(interaction: ChatInputCommandInteraction): Promise<void> {
  const url = interaction.options.getString('url', true);

  await interaction.deferReply();

  let tempDir: string | null = null;

  try {
    await interaction.editReply('Downloading Reddit video...');

    const result = await downloadRedditVideo(
      url,
      discordConfig.DISCORD_VIDEO_MAX_SIZE_MB,
      async (msg) => {
        try {
          await interaction.editReply(msg);
        } catch { /* ignore edit errors */ }
      },
    );
    tempDir = result.tempDir;

    await interaction.editReply('Uploading video...');

    const fileName = `vreddit_${Date.now()}.mp4`;
    const attachment = new AttachmentBuilder(result.filePath, { name: fileName });
    const sizeMB = (result.size / 1024 / 1024).toFixed(1);

    // Try editReply first, fall back to followUp, then channel.send
    try {
      await interaction.editReply({
        content: `Reddit video (${sizeMB} MB)`,
        files: [attachment],
      });
    } catch (uploadError) {
      const errMsg = uploadError instanceof Error ? uploadError.message : '';
      console.warn('[Discord/vReddit] editReply upload failed:', errMsg);

      if (errMsg.toLowerCase().includes('entity too large') || errMsg.includes('413')) {
        // Retry via followUp (different endpoint, may have different limits)
        await interaction.editReply(`Video is ${sizeMB} MB — sending as follow-up...`);
        try {
          const retryAttachment = new AttachmentBuilder(result.filePath, { name: fileName });
          await interaction.followUp({ files: [retryAttachment] });
        } catch (followUpError) {
          // Last resort: send directly to channel
          const chan = interaction.channel;
          if (chan && 'send' in chan) {
            const lastAttachment = new AttachmentBuilder(result.filePath, { name: fileName });
            await chan.send({ files: [lastAttachment] });
            await interaction.editReply(`Reddit video (${sizeMB} MB) — sent below.`);
          } else {
            throw followUpError;
          }
        }
      } else {
        throw uploadError;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to download video.';
    console.warn('[Discord/vReddit]', msg);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Error: ${msg}`);
      }
    } catch { /* interaction expired */ }
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  }
}
