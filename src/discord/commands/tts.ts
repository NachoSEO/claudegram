import {
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonInteraction,
} from 'discord.js';
import { config } from '../../config.js';
import { generateSpeech } from '../../tts/tts.js';
import {
  getTTSSettings,
  setTTSEnabled,
  setTTSVoice,
  isTTSEnabled,
} from '../../tts/tts-settings.js';
import { discordChatId } from '../id-mapper.js';
import { sanitizeError } from '../../utils/sanitize.js';

const GROQ_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const COLLECTOR_TIMEOUT_MS = 60_000;

function getVoicesForProvider(): string[] {
  return config.TTS_PROVIDER === 'groq' ? GROQ_VOICES : OPENAI_VOICES;
}

export async function handleTTS(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'speak') {
    await handleSpeak(interaction);
  } else if (subcommand === 'on') {
    await handleToggle(interaction, true);
  } else if (subcommand === 'off') {
    await handleToggle(interaction, false);
  } else if (subcommand === 'voice') {
    await handleVoiceSelect(interaction);
  } else if (subcommand === 'status') {
    await handleTTSStatus(interaction);
  }
}

async function handleSpeak(interaction: ChatInputCommandInteraction): Promise<void> {
  const text = interaction.options.getString('text', true);

  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  if (!hasKey) {
    await interaction.reply({ content: 'TTS not configured. Missing API key.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const chatId = discordChatId(interaction.user.id);
  const settings = getTTSSettings(chatId);
  const voices = getVoicesForProvider();

  // Build voice buttons (max 5 per row)
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < voices.length; i += 5) {
    const batch = voices.slice(i, i + 5);
    const buttons = batch.map(v =>
      new ButtonBuilder()
        .setCustomId(`tts-voice-${v}`)
        .setLabel(v === settings.voice ? `${v} ✓` : v)
        .setStyle(v === settings.voice ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  }

  const response = await interaction.editReply({
    content: `**Choose a voice** (provider: ${config.TTS_PROVIDER})\n\nText: *"${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"*`,
    components: rows,
  });

  const collector = response.createMessageComponentCollector({ time: COLLECTOR_TIMEOUT_MS });
  let handled = false;

  collector.on('collect', async (i: ButtonInteraction) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: 'Only the command author can use these buttons.', ephemeral: true });
      return;
    }
    if (handled) return;
    handled = true;

    const voice = i.customId.replace('tts-voice-', '');

    // Disable buttons, show generating
    await i.update({ content: `Generating speech with **${voice}**...`, components: [] });

    try {
      const audioBuffer = await generateSpeech(text, voice);
      const ext = config.TTS_PROVIDER === 'groq' ? 'ogg'
        : config.TTS_RESPONSE_FORMAT === 'opus' ? 'ogg'
        : config.TTS_RESPONSE_FORMAT;

      const attachment = new AttachmentBuilder(audioBuffer, { name: `tts_${voice}.${ext}` });
      await interaction.followUp({ files: [attachment] });
    } catch (error) {
      await interaction.followUp({ content: `TTS error: ${sanitizeError(error)}`, ephemeral: true });
    }

    collector.stop();
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'time' && !handled) {
      try {
        await interaction.editReply({ content: 'Voice selection timed out.', components: [] });
      } catch { /* ignore */ }
    }
  });
}

async function handleToggle(interaction: ChatInputCommandInteraction, enabled: boolean): Promise<void> {
  const chatId = discordChatId(interaction.user.id);
  setTTSEnabled(chatId, enabled);
  const state = enabled ? 'ON' : 'OFF';
  const settings = getTTSSettings(chatId);
  await interaction.reply(`TTS **${state}** — voice: **${settings.voice}** (${config.TTS_PROVIDER})`);
}

async function handleVoiceSelect(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);
  const settings = getTTSSettings(chatId);
  const voices = getVoicesForProvider();

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < voices.length; i += 5) {
    const batch = voices.slice(i, i + 5);
    const buttons = batch.map(v =>
      new ButtonBuilder()
        .setCustomId(`tts-set-${v}`)
        .setLabel(v === settings.voice ? `${v} ✓` : v)
        .setStyle(v === settings.voice ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  }

  const response = await interaction.reply({
    content: `**Select default voice** (${config.TTS_PROVIDER})`,
    components: rows,
    fetchReply: true,
  });

  const collector = response.createMessageComponentCollector({ time: COLLECTOR_TIMEOUT_MS });
  let handled = false;

  collector.on('collect', async (i: ButtonInteraction) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: 'Only the command author can use these buttons.', ephemeral: true });
      return;
    }
    if (handled) return;
    handled = true;

    const voice = i.customId.replace('tts-set-', '');
    setTTSVoice(chatId, voice);
    await i.update({ content: `Voice set to **${voice}**`, components: [] });
    collector.stop();
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'time' && !handled) {
      try {
        await interaction.editReply({ content: 'Voice selection timed out.', components: [] });
      } catch { /* ignore */ }
    }
  });
}

async function handleTTSStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);
  const settings = getTTSSettings(chatId);
  const enabled = isTTSEnabled(chatId);
  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;

  let msg = `**TTS Settings**\n`;
  msg += `Status: ${enabled ? 'ON' : 'OFF'}\n`;
  msg += `Provider: ${config.TTS_PROVIDER}\n`;
  msg += `Voice: ${settings.voice}\n`;
  msg += `API key: ${hasKey ? 'configured' : 'missing'}`;

  await interaction.reply({ content: msg, ephemeral: true });
}
