import {
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  TextChannel,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { queueRequest, setAbortController } from '../../claude/request-queue.js';
import {
  extractMedia,
  cleanupExtractResult,
  detectPlatform,
  platformLabel,
  isValidUrl,
  type ExtractMode,
  type ExtractResult,
} from '../../media/extract.js';
import { sanitizeError } from '../../utils/sanitize.js';

const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const TELEGRAM_VIDEO_MAX_MB = 50; // Discord limit is higher (25MB free, 50MB boost) but keep consistent

function platformEmoji(platform: string): string {
  switch (platform) {
    case 'youtube': return '\u{25B6}\u{FE0F}';
    case 'instagram': return '\u{1F4F7}';
    case 'tiktok': return '\u{1F3B5}';
    default: return '\u{1F517}';
  }
}

export async function handleExtract(interaction: ChatInputCommandInteraction): Promise<void> {
  const url = interaction.options.getString('url', true);

  if (!isValidUrl(url)) {
    await interaction.reply({
      content: 'Invalid or unsupported URL. Supported: YouTube, Instagram, TikTok.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const platform = detectPlatform(url);
  const emoji = platformEmoji(platform);
  const label = platformLabel(platform);

  const displayUrl = url.length > 60 ? url.slice(0, 57) + '...' : url;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} Extract — ${label}`)
    .setDescription(`\`${displayUrl}\`\n\nWhat do you want to extract?`)
    .setColor(0x5865F2)
    .setFooter({ text: 'Select a mode below' });

  // Row 1: Text, Audio, Video
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('extract-text').setLabel('\u{1F4DD} Text').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('extract-audio').setLabel('\u{1F3A7} Audio').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('extract-video').setLabel('\u{1F3AC} Video').setStyle(ButtonStyle.Primary),
  );
  // Row 2: All, All + Chat
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('extract-all').setLabel('\u{2728} All').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('extract-all_chat').setLabel('\u{1F4AC} All + Chat').setStyle(ButtonStyle.Success),
  );

  const response = await interaction.editReply({
    content: '',
    embeds: [embed],
    components: [row1, row2],
  });

  const collector = response.createMessageComponentCollector({
    time: COLLECTOR_TIMEOUT_MS,
  });

  let handled = false;

  collector.on('collect', async (i) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: 'Only the command author can use these buttons.', ephemeral: true });
      return;
    }

    if (handled) return;
    handled = true;
    collector.stop('handled');

    const mode = i.customId.replace('extract-', '') as ExtractMode;
    const modeLabel = mode === 'all_chat' ? 'All + Chat'
      : mode.charAt(0).toUpperCase() + mode.slice(1);

    // Disable buttons
    const disabledRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('extract-text').setLabel('\u{1F4DD} Text').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('extract-audio').setLabel('\u{1F3A7} Audio').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('extract-video').setLabel('\u{1F3AC} Video').setStyle(ButtonStyle.Primary).setDisabled(true),
    );
    const disabledRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('extract-all').setLabel('\u{2728} All').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('extract-all_chat').setLabel('\u{1F4AC} All + Chat').setStyle(ButtonStyle.Success).setDisabled(true),
    );

    const progressEmbed = new EmbedBuilder()
      .setTitle(`${emoji} Extract — ${modeLabel}`)
      .setDescription(`\`${displayUrl}\`\n\n\u{23F3} Extracting...`)
      .setColor(0x5865F2);

    await i.update({ embeds: [progressEmbed], components: [disabledRow1, disabledRow2] });

    let result: ExtractResult | null = null;

    try {
      result = await extractMedia({
        url,
        mode,
        onProgress: async (msg) => {
          try {
            const updatedEmbed = new EmbedBuilder()
              .setTitle(`${emoji} Extract — ${modeLabel}`)
              .setDescription(`\`${displayUrl}\`\n\n${msg}`)
              .setColor(0x5865F2);
            await interaction.editReply({ embeds: [updatedEmbed], components: [disabledRow1, disabledRow2] });
          } catch { /* ignore progress update failures */ }
        },
      });

      // Update embed to done
      const doneEmbed = new EmbedBuilder()
        .setTitle(`${emoji} ${result.title}`)
        .setDescription(`\`${displayUrl}\``)
        .setColor(0x57F287)
        .setFooter({ text: `${label} — ${modeLabel}` });

      if (result.warnings.length > 0) {
        doneEmbed.addFields({ name: 'Warnings', value: result.warnings.join('\n').slice(0, 1024) });
      }

      await interaction.editReply({ embeds: [doneEmbed], components: [disabledRow1, disabledRow2] });

      // Send video
      const wantsVideo = mode === 'video' || mode === 'all' || mode === 'all_chat';
      if (wantsVideo && result.videoPath && fs.existsSync(result.videoPath)) {
        const videoSize = fs.statSync(result.videoPath).size;
        const sizeMB = (videoSize / 1024 / 1024).toFixed(1);
        const attachment = new AttachmentBuilder(result.videoPath, {
          name: `${result.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}.mp4`,
        });
        await interaction.followUp({
          content: `\u{1F3AC} Video (${sizeMB}MB)`,
          files: [attachment],
        });
      }

      // Send audio
      const wantsAudio = mode === 'audio' || mode === 'all' || mode === 'all_chat';
      if (wantsAudio && result.audioPath && fs.existsSync(result.audioPath)) {
        const attachment = new AttachmentBuilder(result.audioPath, {
          name: `${result.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}.mp3`,
        });
        await interaction.followUp({
          content: '\u{1F3A7} Audio',
          files: [attachment],
        });
      }

      // Send transcript
      const wantsText = mode === 'text' || mode === 'all' || mode === 'all_chat';
      if (wantsText && result.transcript) {
        if (result.transcript.length <= 2000) {
          await interaction.followUp(`\u{1F4DD} **Transcript:**\n\n${result.transcript}`);
        } else {
          const txtBuffer = Buffer.from(result.transcript, 'utf-8');
          const attachment = new AttachmentBuilder(txtBuffer, { name: 'transcript.txt' });
          await interaction.followUp({
            content: `\u{1F4DD} Transcript (${result.transcript.length.toLocaleString()} chars)`,
            files: [attachment],
          });
        }
      }

      // Send subtitle file
      if (wantsText && result.subtitlePath && fs.existsSync(result.subtitlePath)) {
        const attachment = new AttachmentBuilder(result.subtitlePath, {
          name: path.basename(result.subtitlePath),
        });
        await interaction.followUp({
          content: `\u{1F4C4} Subtitles (${result.subtitleFormat?.toUpperCase() || 'SRT'})`,
          files: [attachment],
        });
      }

      // All + Chat: inject into Claude session
      if (mode === 'all_chat' && result.transcript) {
        const chatId = discordChatId(interaction.user.id);
        const session = sessionManager.getSession(chatId);

        if (!session) {
          await interaction.followUp({
            content: 'No project set. Use `/project` first to chat about extracted content.',
            ephemeral: true,
          });
        } else {
          const contextMessage =
            `[Extract Context — All + Chat]\n` +
            `URL: ${url}\n` +
            `Title: ${result.title}\n` +
            `Platform: ${label}\n\n` +
            `--- TRANSCRIPT ---\n${result.transcript}\n--- END ---\n\n` +
            `The user extracted this content and wants to discuss it. Acknowledge what you received and ask what they'd like to discuss.`;

          const threadTitle = `\u{1F4E5} ${(result.title || 'Extract').slice(0, 90)} + Chat`;
          const channel = interaction.channel;
          if (!channel || !('threads' in channel)) {
            await interaction.followUp({ content: 'Cannot create thread in this channel type.', ephemeral: true });
            return;
          }

          const thread = await (channel as TextChannel).threads.create({
            name: threadTitle.slice(0, 100),
            autoArchiveDuration: 1440,
          });

          await interaction.followUp(`Thread created: ${thread.toString()}`);

          const threadChannelId = thread.id;
          const thinkingEmbed = new EmbedBuilder().setColor(0x5865F2).setDescription('**\u{25CF}\u{25CB}\u{25CB}** Processing');
          const thinkingMsg = await thread.send({ embeds: [thinkingEmbed] });
          await discordMessageSender.startStreamingFromExistingMessage(thinkingMsg, threadChannelId);

          await queueRequest(chatId, contextMessage, async () => {
            const abortController = new AbortController();
            setAbortController(chatId, abortController);

            try {
              const agentResponse = await sendToAgent(chatId, contextMessage, {
                onProgress: (text) => {
                  discordMessageSender.updateStream(threadChannelId, text);
                },
                onToolStart: (toolName, input) => {
                  discordMessageSender.updateToolOperation(threadChannelId, toolName, input);
                },
                onToolEnd: () => {
                  discordMessageSender.clearToolOperation(threadChannelId);
                },
                abortController,
                platform: 'discord',
              });

              await discordMessageSender.finishStreaming(threadChannelId, agentResponse.text);
            } catch (error) {
              await discordMessageSender.cancelStreaming(threadChannelId);
              throw error;
            }
          });
        }
      }

    } catch (err) {
      const errorEmbed = new EmbedBuilder()
        .setTitle(`${emoji} Extract Failed`)
        .setDescription(`\`${displayUrl}\`\n\n\u{274C} ${sanitizeError(err)}`)
        .setColor(0xFF0000);

      try {
        await interaction.editReply({ embeds: [errorEmbed], components: [disabledRow1, disabledRow2] });
      } catch {
        try {
          await interaction.followUp({ content: `Error: ${sanitizeError(err)}`, ephemeral: true });
        } catch { /* interaction expired */ }
      }
    } finally {
      if (result) cleanupExtractResult(result);
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'time' && !handled) {
      const disabledRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('extract-text').setLabel('\u{1F4DD} Text').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('extract-audio').setLabel('\u{1F3A7} Audio').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('extract-video').setLabel('\u{1F3AC} Video').setStyle(ButtonStyle.Primary).setDisabled(true),
      );
      const disabledRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('extract-all').setLabel('\u{2728} All').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('extract-all_chat').setLabel('\u{1F4AC} All + Chat').setStyle(ButtonStyle.Success).setDisabled(true),
      );
      try {
        await interaction.editReply({ components: [disabledRow1, disabledRow2] });
      } catch { /* ignore */ }
    }
  });
}
