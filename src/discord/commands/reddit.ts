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
import { redditFetchBoth, type RedditFetchOptions } from '../../reddit/redditfetch.js';
import { config } from '../../config.js';


function extractThreadTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#+\s+(.+)$/m);
  if (heading) return heading[1].slice(0, 100);
  const first = markdown.split('\n').find(l => l.trim());
  return (first?.replace(/^[#*_>\-\s]+/, '').slice(0, 100)) || fallback.slice(0, 100);
}

const RESULT_TTL_MS = 5 * 60 * 1000;
const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const CHAT_INLINE_LIMIT = 3000;

export async function handleReddit(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getString('target', true);
  const sort = interaction.options.getString('sort') || undefined;
  const limit = interaction.options.getString('limit');

  await interaction.deferReply();

  const targets = [target];
  const options: RedditFetchOptions = {
    format: 'markdown',
    sort: sort || 'hot',
    limit: limit ? parseInt(limit, 10) : config.REDDITFETCH_DEFAULT_LIMIT,
    depth: config.REDDITFETCH_DEFAULT_DEPTH,
  };

  let markdown: string;
  let json: string;

  try {
    const result = await redditFetchBoth(targets, options);
    markdown = result.markdown;
    json = result.json;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    let userMessage: string;
    if (errorMessage.includes('Missing Reddit credentials') || errorMessage.includes('REDDIT_CLIENT_ID')) {
      userMessage = 'Reddit credentials not configured. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD in the .env file.';
    } else if (errorMessage.includes('timed out') || errorMessage.includes('AbortError')) {
      userMessage = 'Reddit fetch timed out.';
    } else {
      userMessage = `Reddit fetch failed: ${errorMessage.substring(0, 300)}`;
    }

    await interaction.editReply(`Error: ${userMessage}`);
    return;
  }

  if (!markdown.trim()) {
    await interaction.editReply('No results returned.');
    return;
  }

  // Build preview
  const charCount = markdown.length;
  const previewSnippet = markdown.length > 300
    ? markdown.slice(0, 300).trimEnd() + '...'
    : markdown;

  const embed = new EmbedBuilder()
    .setTitle('Reddit Fetch')
    .setDescription(previewSnippet)
    .setColor(0xFF4500) // Reddit orange
    .addFields(
      { name: 'Target', value: `\`${target}\``, inline: true },
      { name: 'Size', value: `${charCount.toLocaleString()} chars`, inline: true },
    )
    .setFooter({ text: 'Choose how to consume this content' });

  const fileBtn = new ButtonBuilder()
    .setCustomId('reddit-file')
    .setLabel('File')
    .setStyle(ButtonStyle.Primary);

  const chatBtn = new ButtonBuilder()
    .setCustomId('reddit-chat')
    .setLabel('Chat')
    .setStyle(ButtonStyle.Success);

  const bothBtn = new ButtonBuilder()
    .setCustomId('reddit-both')
    .setLabel('Both')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(fileBtn, chatBtn, bothBtn);

  const response = await interaction.editReply({
    content: '',
    embeds: [embed],
    components: [row],
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

    const action = i.customId.replace('reddit-', '');
    const doFile = action === 'file' || action === 'both';
    const doChat = action === 'chat' || action === 'both';

    // Disable buttons immediately — must create new instances to avoid mutating originals
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('reddit-file').setLabel('File').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('reddit-chat').setLabel('Chat').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId('reddit-both').setLabel('Both').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );

    const actionLabel = action === 'file' ? 'File' : action === 'chat' ? 'Chat' : 'Both';
    const doneEmbed = new EmbedBuilder()
      .setTitle(`Reddit Fetch — ${actionLabel}`)
      .setDescription(`Target: \`${target}\` | ${charCount.toLocaleString()} chars`)
      .setColor(0xFF4500);

    await i.update({ embeds: [doneEmbed], components: [disabledRow] });

    try {
      // ── File mode ──
      if (doFile) {
        // Large thread: send as JSON; otherwise send markdown
        if (markdown.length > config.REDDITFETCH_JSON_THRESHOLD_CHARS) {
          const jsonBuffer = Buffer.from(json, 'utf-8');
          const slug = target.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const attachment = new AttachmentBuilder(jsonBuffer, {
            name: `reddit_${slug}_${stamp}.json`,
          });
          await interaction.followUp({
            content: `Large thread (${charCount.toLocaleString()} chars) — sent as JSON for structured review.`,
            files: [attachment],
          });
        } else {
          const mdBuffer = Buffer.from(markdown, 'utf-8');
          const slug = target.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const attachment = new AttachmentBuilder(mdBuffer, {
            name: `reddit_${slug}_${stamp}.md`,
          });
          await interaction.followUp({ files: [attachment] });
        }
      }

      // ── Chat mode ──
      if (doChat) {
        const chatId = discordChatId(interaction.user.id);
        const session = sessionManager.getSession(chatId);

        if (!session) {
          await interaction.followUp({
            content: 'No project set. Use `/project` first to enable Chat mode.',
            ephemeral: true,
          });
        } else {
          // Save content to disk
          const baseDir = session.workingDirectory;
          const dir = path.join(baseDir, '.claudegram', 'reddit');
          fs.mkdirSync(dir, { recursive: true });
          const slug = target.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const mdPath = path.join(dir, `reddit_${slug}_${stamp}.md`);
          fs.writeFileSync(mdPath, markdown, 'utf-8');

          // Build prompt
          const truncated = markdown.length > CHAT_INLINE_LIMIT;
          const inlineContent = truncated
            ? markdown.slice(0, CHAT_INLINE_LIMIT).trimEnd()
            : markdown;

          const displayPath = `.claudegram/reddit/${path.basename(mdPath)}`;
          let prompt = `I just fetched Reddit content and saved it to ${displayPath}. Here's the content:\n\n${inlineContent}`;
          if (truncated) {
            prompt += `\n\n[Content truncated — full content (${markdown.length} chars) is saved at ${displayPath}.]`;
          }
          prompt += '\n\nPlease summarize the key points and let me know if you have any questions.';

          // Create a thread named after the Reddit content
          const threadTitle = extractThreadTitle(markdown, target);
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

          // Stream Claude response inside the thread
          const threadChannelId = thread.id;
          const thinkingEmbed = new EmbedBuilder().setColor(0x5865F2).setDescription('**●○○** Processing');
          const thinkingMsg = await thread.send({ embeds: [thinkingEmbed] });
          await discordMessageSender.startStreamingFromExistingMessage(thinkingMsg, threadChannelId);

          await queueRequest(chatId, prompt, async () => {
            const abortController = new AbortController();
            setAbortController(chatId, abortController);

            try {
              const agentResponse = await sendToAgent(chatId, prompt, {
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
      const message = err instanceof Error ? err.message : 'Unknown error';
      try {
        await interaction.followUp({ content: `Error: ${message.substring(0, 300)}`, ephemeral: true });
      } catch { /* expired */ }
    }

    collector.stop();
  });

  collector.on('end', async (collected, reason) => {
    if (reason === 'time' && !handled) {
      // Timeout — disable buttons
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('reddit-file').setLabel('File').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('reddit-chat').setLabel('Chat').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('reddit-both').setLabel('Both').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );

      try {
        await interaction.editReply({ components: [disabledRow] });
      } catch { /* ignore */ }
    }
  });
}
