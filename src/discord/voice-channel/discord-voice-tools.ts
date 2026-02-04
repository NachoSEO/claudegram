import { ChannelType, PermissionsBitField, EmbedBuilder, type TextChannel, type ThreadChannel } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import { config } from '../../config.js';
import type { GeminiTool, VoiceToolContext } from './gemini-live.js';

// Lazily-initialized GoogleGenAI client for tools that call the text API.
let cachedTextAI: GoogleGenAI | null = null;
function getTextAI(): GoogleGenAI {
  if (!cachedTextAI) {
    if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
    cachedTextAI = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }
  return cachedTextAI;
}

const RESEARCH_TIMEOUT_MS = 30_000;

/** Check if channel is sendable (text channel or thread) */
function isTextBasedChannel(channel: any): channel is TextChannel | ThreadChannel {
  return channel && (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  );
}

/**
 * Creates Discord-aware voice tools that require access to the Discord client
 * and guild/channel context. These are instantiated per voice session.
 */
export function createDiscordVoiceTools(ctx: VoiceToolContext): GeminiTool[] {
  const tools: GeminiTool[] = [];

  // ── read_chat ───────────────────────────────────────────────────────
  if (ctx.textChannelId) {
    tools.push({
      name: 'read_chat',
      description:
        'Read recent messages from the linked text channel. Use when the user asks what people are saying in chat, what was posted recently, or wants a summary of the text channel.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'number',
            description: 'Number of messages to fetch (1-50). Default 10.',
          },
        },
      },
      behavior: 'NON_BLOCKING',
      execute: async (args) => {
        const count = Math.max(1, Math.min(Math.floor(Number(args.count) || 10), 50));
        const channel = ctx.client.channels.cache.get(ctx.textChannelId!);
        if (!isTextBasedChannel(channel)) {
          return { error: 'Text channel not found or not a text channel.' };
        }
        try {
          const messages = await channel.messages.fetch({ limit: count });
          const result = messages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => ({
              author: m.member?.displayName ?? m.author.username,
              content: m.content || (m.embeds.length > 0 ? '[embed]' : '[no content]'),
              timestamp: m.createdAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            }));
          return { messages: result, count: result.length };
        } catch (err: any) {
          return { error: `Failed to fetch messages: ${err.message}` };
        }
      },
    });
  }

  // ── send_message ────────────────────────────────────────────────────
  if (ctx.textChannelId) {
    tools.push({
      name: 'send_message',
      description:
        'Send a text message to the linked text channel. Use when the user asks you to post something in chat or send a message to the text channel.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The message to send (max 2000 characters).',
          },
        },
        required: ['message'],
      },
      behavior: 'NON_BLOCKING',
      execute: async (args) => {
        const message = String(args.message).trim().slice(0, 2000);
        if (!message) return { error: 'Message cannot be empty.' };
        const channel = ctx.client.channels.cache.get(ctx.textChannelId!);
        if (!isTextBasedChannel(channel)) {
          return { error: 'Text channel not found or not a text channel.' };
        }
        try {
          await channel.send({
            content: message,
            allowedMentions: { parse: ['users'] }, // Allow @user mentions, block @everyone/@here
          });
          return { success: true, sent: message };
        } catch (err: any) {
          return { error: `Failed to send message: ${err.message}` };
        }
      },
    });
  }

  // ── kick_from_voice ─────────────────────────────────────────────────
  tools.push({
    name: 'kick_from_voice',
    description:
      'Disconnect a user from the voice channel by their display name or username. Use when someone asks you to kick or remove a specific person from voice. Cannot kick the bot itself.',
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'The exact display name of the user to kick from voice.',
        },
      },
      required: ['username'],
    },
    execute: async (args) => {
      const target = String(args.username).toLowerCase();
      if (!target) return { error: 'Username is required.' };

      const guild = ctx.client.guilds.cache.get(ctx.guildId);
      if (!guild) return { error: 'Guild not found.' };

      const botId = ctx.client.user?.id;
      const me = botId ? guild.members.cache.get(botId) : null;
      if (me && !me.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
        return { error: 'I don\'t have the Move Members permission needed to kick users from voice.' };
      }

      const voiceChannel = guild.channels.cache.get(ctx.channelId);
      if (!voiceChannel || !voiceChannel.isVoiceBased()) {
        return { error: 'Voice channel not found.' };
      }

      // Find the member by exact case-insensitive name match
      const members = voiceChannel.members;
      const matches = members.filter(
        (m) =>
          m.id !== botId &&
          (m.displayName.toLowerCase() === target ||
            m.user.username.toLowerCase() === target),
      );

      if (matches.size === 0) {
        const names = members
          .filter((m) => m.id !== botId)
          .map((m) => m.displayName);
        return {
          error: `No user matching "${args.username}" found in the voice channel.`,
          usersInChannel: names,
        };
      }

      if (matches.size > 1) {
        return {
          error: `Multiple users match "${args.username}". Please be more specific.`,
          matchedUsers: matches.map((m) => m.displayName),
        };
      }

      const match = matches.first()!;
      try {
        const botName = ctx.client.user?.displayName ?? 'bot';
        await match.voice.disconnect(`Kicked by ${botName} voice command`);
        return { success: true, kicked: match.displayName };
      } catch (err: any) {
        return { error: `Failed to kick ${match.displayName}: ${err.message}` };
      }
    },
  });

  // ── deep_research ──────────────────────────────────────────────────
  // Discord-aware version that posts results to the text channel
  if (ctx.textChannelId) {
    tools.push({
      name: 'deep_research',
      description:
        'Perform thorough research on a topic using Google Search and post the full report to the text channel. Use for questions that need up-to-date info, detailed answers, gaming strategies, news, or anything requiring web search. Runs in the background — the conversation can continue while research is happening.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The research question or topic to investigate.',
          },
        },
        required: ['query'],
      },
      behavior: 'NON_BLOCKING',
      execute: async (args) => {
        const query = String(args.query);
        if (!config.GEMINI_API_KEY) {
          return { error: 'GEMINI_API_KEY not configured for research.' };
        }

        const channel = ctx.client.channels.cache.get(ctx.textChannelId!);
        if (!isTextBasedChannel(channel)) {
          return { error: 'Text channel not found for posting research results.' };
        }

        try {
          const ai = getTextAI();
          const research = ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [
              {
                role: 'user',
                parts: [{ text: `Research this topic thoroughly and provide a concise, informative summary:\n\n${query}` }],
              },
            ],
            config: {
              tools: [{ googleSearch: {} }],
            },
          });

          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Research timed out after 30s')), RESEARCH_TIMEOUT_MS),
          );

          const response = await Promise.race([research, timeout]);
          const text = response.text ?? '';
          const capped = text.length > 4000 ? text.slice(0, 4000) + '...' : text;

          // Post the research as an embed to the text channel
          const embed = new EmbedBuilder()
            .setTitle(`🔍 Research: ${query.slice(0, 200)}`)
            .setDescription(capped)
            .setColor(0x4285f4) // Google blue
            .setFooter({ text: 'Powered by Gemini 2.0 Flash + Google Search' })
            .setTimestamp();

          await channel.send({ embeds: [embed] });

          // Return a brief summary for Gemini to speak
          const briefSummary = capped.length > 500 ? capped.slice(0, 500) + '...' : capped;
          return {
            query,
            posted: true,
            summary: briefSummary,
            instruction: 'The full research report has been posted in the text channel. Give a brief verbal summary of the key points.',
          };
        } catch (err: any) {
          console.error('[VoiceTools] deep_research failed:', err.message);
          return { query, error: `Research failed: ${err.message}` };
        }
      },
    });
  }

  return tools;
}
