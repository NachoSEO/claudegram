import {
  Message,
  ChannelType,
} from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { isAuthorizedMessage } from '../middleware/auth.js';
import { discordMessageSender } from '../message-sender.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { sanitizeError } from '../../utils/sanitize.js';

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(message.client.user!);
  const isThread =
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread;

  // Only respond to @mentions or thread messages
  if (!isMentioned && !isThread) return;

  // Auth check
  if (!isAuthorizedMessage(message)) {
    await message.reply('You are not authorized to use this bot.');
    return;
  }

  // Strip the mention from the text
  let text = message.content;
  if (isMentioned && message.client.user) {
    text = text.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
  }

  if (!text || text.trim().length === 0) return;

  // Session key uses the user's ID, not the channel ID
  const chatId = discordChatId(message.author.id);
  // Channel ID is used for message sending/streaming
  const channelId = message.channelId;

  // Check for active session
  const session = sessionManager.getSession(chatId);
  if (!session) {
    await message.reply('No project set. Use `/project <path>` first.');
    return;
  }

  // Show queue position if already processing
  if (isProcessing(chatId)) {
    const position = getQueuePosition(chatId) + 1;
    await message.reply(`Queued (position ${position})`);
  }

  // React with hourglass to indicate processing
  try {
    await message.react('\u23F3');
  } catch { /* ignore reaction errors */ }

  try {
    await queueRequest(chatId, text, async () => {
      await discordMessageSender.startStreamingFromMessage(message, channelId);

      const abortController = new AbortController();
      setAbortController(chatId, abortController);

      try {
        const response = await sendToAgent(chatId, text, {
          onProgress: (progressText) => {
            discordMessageSender.updateStream(channelId, progressText);
          },
          onToolStart: (toolName, input) => {
            discordMessageSender.updateToolOperation(channelId, toolName, input);
          },
          onToolEnd: () => {
            discordMessageSender.clearToolOperation(channelId);
          },
          abortController,
          platform: 'discord',
        });

        await discordMessageSender.finishStreaming(channelId, response.text);

        // Remove hourglass, add checkmark
        try {
          await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user!.id);
          await message.react('\u2705');
        } catch { /* ignore reaction errors */ }
      } catch (error) {
        await discordMessageSender.cancelStreaming(channelId);

        // Remove hourglass, add cross mark
        try {
          await message.reactions.cache.get('\u23F3')?.users.remove(message.client.user!.id);
          await message.react('\u274C');
        } catch { /* ignore reaction errors */ }

        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    console.error('[Discord] Message error:', error);
    await message.reply(`Error: ${sanitizeError(error)}`).catch(() => {});
  }
}
