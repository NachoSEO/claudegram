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

/**
 * Retrieve the current Discord client instance managed by this module.
 *
 * @returns The active `Client` instance, or `null` if the client has not been created.
 */
export function getDiscordClient(): Client | null {
  return botClient;
}

/**
 * Create and configure a Discord.js client with the required gateway intents, register ready/interaction/message event handlers, and store it in the module-scoped `botClient`.
 *
 * @returns The initialized Discord Client instance.
 */
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

    try {
      const { attachJobNotifier } = require("./jobs/job-notifier.js");
      attachJobNotifier(readyClient);
      console.log("[Jobs] Job notifier attached");
    } catch (e) {
      console.error("[Jobs] Failed to attach job notifier", e);
    }
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