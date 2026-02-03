import { ChannelType, PermissionsBitField, type TextChannel } from 'discord.js';
import type { GeminiTool, VoiceToolContext } from './gemini-live.js';

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
        if (!channel || channel.type !== ChannelType.GuildText) {
          return { error: 'Text channel not found or not a text channel.' };
        }
        try {
          const messages = await (channel as TextChannel).messages.fetch({ limit: count });
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
        if (!channel || channel.type !== ChannelType.GuildText) {
          return { error: 'Text channel not found or not a text channel.' };
        }
        try {
          await (channel as TextChannel).send({
            content: message,
            allowedMentions: { parse: [] },
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
      'Disconnect a user from the voice channel by their exact display name. Use when someone asks you to kick or remove a specific person from voice. Cannot kick the bot itself.',
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
        await match.voice.disconnect('Kicked by BigBroDoe voice command');
        return { success: true, kicked: match.displayName };
      } catch (err: any) {
        return { error: `Failed to kick ${match.displayName}: ${err.message}` };
      }
    },
  });

  return tools;
}
