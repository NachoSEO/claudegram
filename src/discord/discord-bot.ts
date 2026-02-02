import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
} from 'discord.js';
import { discordConfig } from './discord-config.js';
import { handleInteraction } from './handlers/interaction.handler.js';
import { handleMessage } from './handlers/message.handler.js';

let botClient: Client | null = null;

export function getDiscordClient(): Client | null {
  return botClient;
}

export function createDiscordBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  botClient = client;

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bot ready as @${readyClient.user.tag}`);
    readyClient.user.setActivity('Ready', { type: ActivityType.Custom });
  });

  // Slash command handling
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (error) {
      console.error('[Discord] Interaction error:', error);
    }
  });

  // Message handling (@mentions and thread messages)
  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message);
    } catch (error) {
      console.error('[Discord] Message error:', error);
    }
  });

  return client;
}
