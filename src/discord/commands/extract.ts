import {
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  TextChannel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { discordConfig } from '../discord-config.js';
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
import {
  type BrowserState,
  BROWSER_TIMEOUT,
  getBrowserRoot,
  buildBrowserUI,
  isWithinRoot,
  setProject,
} from '../project-browser.js';

const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const EXTRACT_BROWSER_PREFIX = 'extproj'; // unique prefix to avoid collision with /project

function platformEmoji(platform: string): string {
  switch (platform) {
    case 'youtube': return '\u{25B6}\u{FE0F}';
    case 'instagram': return '\u{1F4F7}';
    case 'tiktok': return '\u{1F3B5}';
    default: return '\u{1F517}';
  }
}

function safeFileName(title: string): string {
  return title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

/** Compress video with ffmpeg to fit Discord upload limit. Returns new path or null. */
function compressVideo(inputPath: string, outputDir: string, maxSizeMB: number): Promise<string | null> {
  return new Promise((resolve) => {
    const outPath = path.join(outputDir, 'compressed.mp4');
    const targetBitrate = Math.floor((maxSizeMB * 8 * 1024) / 60); // rough: assume 60s max
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k',
      '-maxrate', `${targetBitrate}k`, '-bufsize', `${targetBitrate * 2}k`,
      '-movflags', '+faststart',
      '-fs', `${maxSizeMB * 1024 * 1024}`,
      outPath,
    ], { timeout: 120_000 }, (error) => {
      if (error || !fs.existsSync(outPath)) {
        resolve(null);
      } else {
        resolve(outPath);
      }
    });
  });
}

/** Build disabled button rows for after selection */
function disabledRows(): [ActionRowBuilder<ButtonBuilder>, ActionRowBuilder<ButtonBuilder>] {
  const r1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('extract-text').setLabel('\u{1F4DD} Text').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('extract-audio').setLabel('\u{1F3A7} Audio').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('extract-video').setLabel('\u{1F3AC} Video').setStyle(ButtonStyle.Primary).setDisabled(true),
  );
  const r2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('extract-all').setLabel('\u{2728} All').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('extract-all_chat').setLabel('\u{1F4AC} All + Chat').setStyle(ButtonStyle.Success).setDisabled(true),
  );
  return [r1, r2];
}

/** Compress audio with ffmpeg to fit within a size limit. Returns new path or null. */
function compressAudio(inputPath: string, outputDir: string, maxSizeMB: number): Promise<string | null> {
  return new Promise((resolve) => {
    const outPath = path.join(outputDir, 'compressed.mp3');
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:a', 'libmp3lame', '-b:a', '96k', // aggressive compression for Discord
      '-fs', `${maxSizeMB * 1024 * 1024}`,
      outPath,
    ], { timeout: 120_000 }, (error) => {
      if (error || !fs.existsSync(outPath)) {
        resolve(null);
      } else {
        resolve(outPath);
      }
    });
  });
}

const DISCORD_MAX_UPLOAD_MB = 25; // free-tier per-file limit

/** Send media files to a channel or as interaction follow-ups */
async function sendMediaFiles(
  result: ExtractResult,
  mode: ExtractMode,
  sender: { send: (opts: any) => Promise<any> } | null,
  interaction: ChatInputCommandInteraction | null,
  maxVideoMB: number,
): Promise<void> {
  const send = async (opts: any) => {
    try {
      if (sender) {
        await sender.send(opts);
      } else if (interaction) {
        await interaction.followUp(opts);
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error('[extract] Failed to send media:', errMsg);
      // Notify user about the failure
      const label = opts.content?.slice(0, 50) || 'file';
      const warning = `\u{26A0}\u{FE0F} Failed to upload ${label}: ${errMsg.includes('entity too large') ? 'file exceeds Discord\u2019s 25MB upload limit' : errMsg}`;
      try {
        if (sender) {
          await sender.send({ content: warning });
        } else if (interaction) {
          await interaction.followUp({ content: warning });
        }
      } catch { /* can't even send the warning */ }
    }
  };

  const maxUploadBytes = DISCORD_MAX_UPLOAD_MB * 1024 * 1024;
  const wantsVideo = mode === 'video' || mode === 'all' || mode === 'all_chat';
  const wantsAudio = mode === 'audio' || mode === 'all' || mode === 'all_chat';
  const wantsText = mode === 'text' || mode === 'all' || mode === 'all_chat';

  // Video
  if (wantsVideo && result.videoPath && fs.existsSync(result.videoPath)) {
    let videoPath = result.videoPath;
    let videoSize = fs.statSync(videoPath).size;
    const maxBytes = maxVideoMB * 1024 * 1024;

    // Compress if over Discord limit
    if (videoSize > maxBytes) {
      const compressed = await compressVideo(videoPath, path.dirname(videoPath), maxVideoMB);
      if (compressed && fs.existsSync(compressed)) {
        videoPath = compressed;
        videoSize = fs.statSync(compressed).size;
      }
    }

    if (videoSize <= maxBytes) {
      const sizeMB = (videoSize / 1024 / 1024).toFixed(1);
      const attachment = new AttachmentBuilder(videoPath, {
        name: `${safeFileName(result.title)}.mp4`,
      });
      await send({ content: `\u{1F3AC} Video (${sizeMB}MB)`, files: [attachment] });
    } else {
      await send({ content: `\u{26A0}\u{FE0F} Video too large (${(videoSize / 1024 / 1024).toFixed(1)}MB) \u2014 exceeds ${maxVideoMB}MB limit even after compression.` });
    }
  }

  // Audio — check size and compress if needed
  if (wantsAudio && result.audioPath && fs.existsSync(result.audioPath)) {
    let audioPath = result.audioPath;
    let audioSize = fs.statSync(audioPath).size;

    if (audioSize > maxUploadBytes) {
      const compressed = await compressAudio(audioPath, path.dirname(audioPath), DISCORD_MAX_UPLOAD_MB);
      if (compressed && fs.existsSync(compressed)) {
        audioPath = compressed;
        audioSize = fs.statSync(compressed).size;
      }
    }

    if (audioSize <= maxUploadBytes) {
      const sizeMB = (audioSize / 1024 / 1024).toFixed(1);
      const attachment = new AttachmentBuilder(audioPath, {
        name: `${safeFileName(result.title)}.mp3`,
      });
      await send({ content: `\u{1F3A7} Audio (${sizeMB}MB)`, files: [attachment] });
    } else {
      await send({ content: `\u{26A0}\u{FE0F} Audio too large (${(audioSize / 1024 / 1024).toFixed(1)}MB) \u2014 exceeds ${DISCORD_MAX_UPLOAD_MB}MB Discord upload limit.` });
    }
  }

  // Transcript
  if (wantsText && result.transcript) {
    if (result.transcript.length <= 2000) {
      await send({ content: `\u{1F4DD} **Transcript:**\n\n${result.transcript}` });
    } else {
      const txtBuffer = Buffer.from(result.transcript, 'utf-8');
      const attachment = new AttachmentBuilder(txtBuffer, { name: 'transcript.txt' });
      await send({
        content: `\u{1F4DD} Transcript (${result.transcript.length.toLocaleString()} chars)`,
        files: [attachment],
      });
    }
  }

  // Subtitle file
  if (wantsText && result.subtitlePath && fs.existsSync(result.subtitlePath)) {
    const attachment = new AttachmentBuilder(result.subtitlePath, {
      name: path.basename(result.subtitlePath),
    });
    await send({
      content: `\u{1F4C4} Subtitles (${result.subtitleFormat?.toUpperCase() || 'SRT'})`,
      files: [attachment],
    });
  }
}

/**
 * Show an ephemeral directory picker and wait for the user to select a project.
 * Returns the chosen directory path, or null if they timed out / cancelled.
 */
async function promptProjectPicker(
  interaction: ChatInputCommandInteraction,
  chatId: number,
): Promise<string | null> {
  const root = getBrowserRoot();
  const state: BrowserState = { root, current: root, page: 0 };
  const prefix = EXTRACT_BROWSER_PREFIX;

  const ui = buildBrowserUI(state, prefix);
  const pickerMsg = await interaction.followUp({
    content:
      '\u{1F4C1} **All + Chat needs a project directory.**\n' +
      'Pick one below and extraction will start automatically.\n\n' +
      ui.content,
    components: ui.components,
    ephemeral: true,
  });

  return new Promise<string | null>((resolve) => {
    const collector = pickerMsg.createMessageComponentCollector({ time: BROWSER_TIMEOUT });
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      collector.stop();
      resolve(result);
    };

    collector.on('collect', async (bi) => {
      try {
        // Directory select — navigate into
        if (bi.isStringSelectMenu() && bi.customId === `${prefix}-dir-select`) {
          const selected = bi.values[0];
          const nextPath = path.join(state.current, selected);
          if (fs.existsSync(nextPath) && fs.statSync(nextPath).isDirectory()) {
            state.current = nextPath;
            state.page = 0;
          }
          const updated = buildBrowserUI(state, prefix);
          await bi.update({ content: updated.content, components: updated.components });
          return;
        }

        if (!bi.isButton()) return;

        switch (bi.customId) {
          case `${prefix}-up`: {
            const parent = path.dirname(state.current);
            if (parent !== state.current) {
              state.current = parent;
              state.page = 0;
            }
            const updated = buildBrowserUI(state, prefix);
            await bi.update({ content: updated.content, components: updated.components });
            break;
          }

          case `${prefix}-use`: {
            const dirPath = state.current;
            const confirmMsg = setProject(chatId, dirPath);
            await bi.update({ content: `${confirmMsg}\n\n\u{23F3} Starting extraction\u2026`, components: [] });
            finish(dirPath);
            break;
          }

          case `${prefix}-prev`: {
            state.page = Math.max(0, state.page - 1);
            const updated = buildBrowserUI(state, prefix);
            await bi.update({ content: updated.content, components: updated.components });
            break;
          }

          case `${prefix}-next`: {
            state.page += 1;
            const updated = buildBrowserUI(state, prefix);
            await bi.update({ content: updated.content, components: updated.components });
            break;
          }

          case `${prefix}-manual`: {
            const modal = new ModalBuilder()
              .setCustomId(`${prefix}-modal-${interaction.user.id}`)
              .setTitle('Enter Project Path');

            const input = new TextInputBuilder()
              .setCustomId(`${prefix}-path-input`)
              .setLabel('Directory path')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('/home/user/projects/myapp')
              .setValue(state.current)
              .setRequired(true);

            modal.addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(input),
            );

            await bi.showModal(modal);

            try {
              const modalSubmit = await bi.awaitModalSubmit({ time: 60_000 });
              let inputPath = modalSubmit.fields.getTextInputValue(`${prefix}-path-input`).trim();

              if (inputPath.startsWith('~')) {
                inputPath = path.join(process.env.HOME || '', inputPath.slice(1));
              }
              inputPath = path.resolve(inputPath);

              if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
                await modalSubmit.reply({
                  content: `Not a valid directory: \`${inputPath}\``,
                  ephemeral: true,
                });
                return;
              }

              const confirmMsg = setProject(chatId, inputPath);
              if (modalSubmit.isFromMessage()) {
                await modalSubmit.update({ content: `${confirmMsg}\n\n\u{23F3} Starting extraction\u2026`, components: [] });
              } else {
                await modalSubmit.reply({ content: `${confirmMsg}\n\n\u{23F3} Starting extraction\u2026`, components: [], ephemeral: true });
              }
              finish(inputPath);
            } catch {
              // Modal timed out
            }
            break;
          }
        }
      } catch (error) {
        console.error('[Discord] Extract project picker error:', error);
      }
    });

    collector.on('end', (_collected, reason) => {
      if (!resolved) {
        finish(null); // timed out
      }
    });
  });
}

/**
 * Run the full All + Chat extraction flow:
 * extract → create thread → post media → stream Claude response.
 */
async function runAllChatExtraction(
  interaction: ChatInputCommandInteraction,
  url: string,
  emoji: string,
  label: string,
  displayUrl: string,
  maxVideoMB: number,
  chatId: number,
): Promise<void> {
  const modeLabel = 'All + Chat';

  const progressEmbed = new EmbedBuilder()
    .setTitle(`${emoji} Extract \u2014 ${modeLabel}`)
    .setDescription(`\`${displayUrl}\`\n\n\u{23F3} Extracting...`)
    .setColor(0x5865F2);

  await interaction.editReply({ embeds: [progressEmbed], components: disabledRows() });

  let result: ExtractResult | null = null;

  try {
    result = await extractMedia({
      url,
      mode: 'all_chat',
      onProgress: async (msg) => {
        try {
          const updatedEmbed = new EmbedBuilder()
            .setTitle(`${emoji} Extract \u2014 ${modeLabel}`)
            .setDescription(`\`${displayUrl}\`\n\n${msg}`)
            .setColor(0x5865F2);
          await interaction.editReply({ embeds: [updatedEmbed], components: disabledRows() });
        } catch { /* ignore progress update failures */ }
      },
    });

    // Update embed to done
    const doneEmbed = new EmbedBuilder()
      .setTitle(`${emoji} ${result.title}`)
      .setDescription(`\`${displayUrl}\``)
      .setColor(0x57F287)
      .setFooter({ text: `${label} \u2014 ${modeLabel}` });

    if (result.warnings.length > 0) {
      doneEmbed.addFields({ name: 'Warnings', value: result.warnings.join('\n').slice(0, 1024) });
    }

    await interaction.editReply({ embeds: [doneEmbed], components: disabledRows() });

    // Create thread — resolve to a text channel that supports threads
    const threadTitle = `\u{1F4E5} ${(result.title || 'Extract').slice(0, 90)}`;
    let threadParent = interaction.channelId
      ? await interaction.client.channels.fetch(interaction.channelId).catch(() => null)
      : null;

    // If command was run inside a thread, use its parent text channel
    if (threadParent && 'parentId' in threadParent && threadParent.parentId && !('threads' in threadParent)) {
      threadParent = await interaction.client.channels.fetch(threadParent.parentId).catch(() => null);
    }

    if (!threadParent || !('threads' in threadParent)) {
      await interaction.followUp({ content: 'Cannot create thread in this channel type.', ephemeral: true });
      return;
    }

    const thread = await (threadParent as TextChannel).threads.create({
      name: threadTitle.slice(0, 100),
      autoArchiveDuration: 1440,
    });

    await interaction.followUp(`Thread created: ${thread.toString()}`);

    // Post info header in the thread
    const durationStr = result.duration
      ? `${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')}`
      : 'unknown';
    await thread.send(
      `${emoji} **${result.title}**\n` +
      `${url}\n` +
      `(${durationStr})`,
    );

    // Post all media inside the thread
    await sendMediaFiles(result, 'all_chat', thread, null, maxVideoMB);

    // Stream Claude response in the thread
    const contextMessage =
      `[Extract Context \u2014 All + Chat]\n` +
      `URL: ${url}\n` +
      `Title: ${result.title}\n` +
      `Platform: ${label}\n\n` +
      `--- TRANSCRIPT ---\n${result.transcript || '(No transcript available)'}\n--- END ---\n\n` +
      `The user extracted this content and wants to discuss it. Acknowledge what you received and ask what they'd like to discuss.`;

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
  } catch (err) {
    const errorEmbed = new EmbedBuilder()
      .setTitle(`${emoji} Extract Failed`)
      .setDescription(`\`${displayUrl}\`\n\n\u{274C} ${sanitizeError(err)}`)
      .setColor(0xFF0000);

    try {
      await interaction.editReply({ embeds: [errorEmbed], components: disabledRows() });
    } catch {
      try {
        await interaction.followUp({ content: `Error: ${sanitizeError(err)}`, ephemeral: true });
      } catch { /* interaction expired */ }
    }
  } finally {
    if (result) cleanupExtractResult(result);
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
  const maxVideoMB = discordConfig.DISCORD_VIDEO_MAX_SIZE_MB;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} Extract \u2014 ${label}`)
    .setDescription(`\`${displayUrl}\`\n\nWhat do you want to extract?`)
    .setColor(0x5865F2)
    .setFooter({ text: 'Select a mode below' });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('extract-text').setLabel('\u{1F4DD} Text').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('extract-audio').setLabel('\u{1F3A7} Audio').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('extract-video').setLabel('\u{1F3AC} Video').setStyle(ButtonStyle.Primary),
  );
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

    // ── All + Chat: check project first ──────────────────────────────
    if (mode === 'all_chat') {
      const chatId = discordChatId(interaction.user.id);
      const session = sessionManager.getSession(chatId);

      if (!session) {
        // Disable buttons while they pick a project
        const [dr1, dr2] = disabledRows();
        const waitEmbed = new EmbedBuilder()
          .setTitle(`${emoji} Extract \u2014 All + Chat`)
          .setDescription(`\`${displayUrl}\`\n\n\u{1F4C1} Pick a project directory to continue.`)
          .setColor(0xFEE75C);

        await i.update({ embeds: [waitEmbed], components: [dr1, dr2] });

        // Show ephemeral directory picker
        const chosenDir = await promptProjectPicker(interaction, chatId);

        if (!chosenDir) {
          // Timed out or cancelled — reset embed
          const cancelEmbed = new EmbedBuilder()
            .setTitle(`${emoji} Extract \u2014 Cancelled`)
            .setDescription(`\`${displayUrl}\`\n\nNo project selected. Use \`/project\` to set one, then try again.`)
            .setColor(0xFF0000);
          try {
            await interaction.editReply({ embeds: [cancelEmbed], components: disabledRows() });
          } catch { /* ignore */ }
          return;
        }

        // Project is now set — proceed with extraction
        await runAllChatExtraction(interaction, url, emoji, label, displayUrl, maxVideoMB, chatId);
        return;
      }

      // Project already set — proceed directly
      const [dr1, dr2] = disabledRows();
      const progressEmbed = new EmbedBuilder()
        .setTitle(`${emoji} Extract \u2014 All + Chat`)
        .setDescription(`\`${displayUrl}\`\n\n\u{23F3} Extracting...`)
        .setColor(0x5865F2);

      await i.update({ embeds: [progressEmbed], components: [dr1, dr2] });
      await runAllChatExtraction(interaction, url, emoji, label, displayUrl, maxVideoMB, chatId);
      return;
    }

    // ── Standard modes (Text, Audio, Video, All) ─────────────────────
    const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
    const [disabledRow1, disabledRow2] = disabledRows();

    const progressEmbed = new EmbedBuilder()
      .setTitle(`${emoji} Extract \u2014 ${modeLabel}`)
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
              .setTitle(`${emoji} Extract \u2014 ${modeLabel}`)
              .setDescription(`\`${displayUrl}\`\n\n${msg}`)
              .setColor(0x5865F2);
            await interaction.editReply({ embeds: [updatedEmbed], components: disabledRows() });
          } catch { /* ignore progress update failures */ }
        },
      });

      // Update embed to done
      const doneEmbed = new EmbedBuilder()
        .setTitle(`${emoji} ${result.title}`)
        .setDescription(`\`${displayUrl}\``)
        .setColor(0x57F287)
        .setFooter({ text: `${label} \u2014 ${modeLabel}` });

      if (result.warnings.length > 0) {
        doneEmbed.addFields({ name: 'Warnings', value: result.warnings.join('\n').slice(0, 1024) });
      }

      await interaction.editReply({ embeds: [doneEmbed], components: disabledRows() });

      // Post media to channel
      await sendMediaFiles(result, mode, null, interaction, maxVideoMB);

    } catch (err) {
      const errorEmbed = new EmbedBuilder()
        .setTitle(`${emoji} Extract Failed`)
        .setDescription(`\`${displayUrl}\`\n\n\u{274C} ${sanitizeError(err)}`)
        .setColor(0xFF0000);

      try {
        await interaction.editReply({ embeds: [errorEmbed], components: disabledRows() });
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
      try {
        await interaction.editReply({ components: disabledRows() });
      } catch { /* ignore */ }
    }
  });
}
