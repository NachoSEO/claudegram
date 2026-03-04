import {
  REST,
  Routes,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
} from 'discord.js';
import { discordConfig } from '../discord-config.js';

const commands = [
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Send a message to Claude')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Your message to Claude')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel the current running request'),

  new SlashCommandBuilder()
    .setName('softreset')
    .setDescription('Clear the current session and start fresh'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and current session info'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear conversation history (keeps session)'),

  new SlashCommandBuilder()
    .setName('project')
    .setDescription('Set the working directory for Claude')
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Absolute path to the project directory')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Select the Claude model'),

  new SlashCommandBuilder()
    .setName('commands')
    .setDescription('List all available commands'),

  new SlashCommandBuilder()
    .setName('reddit')
    .setDescription('Fetch Reddit posts, subreddits, or user profiles')
    .addStringOption(option =>
      option.setName('target')
        .setDescription('Subreddit (r/ClaudeAI), post URL, user (u/name), or post ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('sort')
        .setDescription('Sort order (hot, new, top, rising)')
        .setRequired(false)
        .addChoices(
          { name: 'Hot', value: 'hot' },
          { name: 'New', value: 'new' },
          { name: 'Top', value: 'top' },
          { name: 'Rising', value: 'rising' },
        )
    )
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Number of posts to fetch (default 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName('vreddit')
    .setDescription('Download a Reddit video')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('Reddit post URL containing a video')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('extract')
    .setDescription('Extract text, audio, or video from YouTube/Instagram/TikTok')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('URL to extract from')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('creview')
    .setDescription('Run CodeRabbit review locally (prompt-only) and return results')
    .addStringOption(option =>
      option.setName('base')
        .setDescription('Base ref to diff against (default: origin/main)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('type')
        .setDescription('What to review (default: committed)')
        .setRequired(false)
        .addChoices(
          { name: 'Committed', value: 'committed' },
          { name: 'Uncommitted', value: 'uncommitted' },
          { name: 'All', value: 'all' },
        )
    ),

  new SlashCommandBuilder()
    .setName('continue')
    .setDescription('Resume the most recent session'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Pick a past session to resume'),

  new SlashCommandBuilder()
    .setName('context')
    .setDescription('Show Claude context window usage'),

  new SlashCommandBuilder()
    .setName('teleport')
    .setDescription('Get the session ID to resume in your terminal'),

  new SlashCommandBuilder()
    .setName('transcribe')
    .setDescription('Transcribe an audio file to text')
    .addAttachmentOption(option =>
      option.setName('file')
        .setDescription('Audio or video file to transcribe')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Text-to-speech tools')
    .addSubcommand(sub =>
      sub.setName('speak')
        .setDescription('Convert text to speech')
        .addStringOption(opt =>
          opt.setName('text')
            .setDescription('Text to speak')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('on')
        .setDescription('Enable TTS auto-reply on agent responses')
    )
    .addSubcommand(sub =>
      sub.setName('off')
        .setDescription('Disable TTS auto-reply')
    )
    .addSubcommand(sub =>
      sub.setName('voice')
        .setDescription('Choose your default TTS voice')
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show current TTS settings')
    ),

  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Gemini Live Audio in voice channels')
    .addSubcommand(sub =>
      sub.setName('join')
        .setDescription('Join your voice channel with Gemini Live')
    )
    .addSubcommand(sub =>
      sub.setName('leave')
        .setDescription('Leave the voice channel')
    )
    .addSubcommand(sub =>
      sub.setName('say')
        .setDescription('Send a text prompt to Gemini (responds with voice)')
        .addStringOption(opt =>
          opt.setName('text')
            .setDescription('Text to send to Gemini')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show voice session status')
    ),

  new SlashCommandBuilder()
    .setName('droid')
    .setDescription('Run Factory Droid autonomous coding agent')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Task for the droid to execute')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('model')
        .setDescription('Model to use (default: groq/llama-4-scout)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('auto')
        .setDescription('Autonomy level')
        .setRequired(false)
        .addChoices(
          { name: 'Low', value: 'low' },
          { name: 'Medium', value: 'medium' },
          { name: 'High', value: 'high' },
        )
    )
    .addStringOption(option =>
      option.setName('spec')
        .setDescription('Path to spec file for context')
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('audio')
        .setDescription('Audio file to transcribe as the prompt')
        .setRequired(false)
    ),


  new SlashCommandBuilder()
    .setName('devops')
    .setDescription('Run background DevOps jobs (build, typecheck, etc.)')
    .addSubcommand(sub =>
      sub.setName('run')
        .setDescription('Run a devops job')
        .addStringOption(opt =>
          opt.setName('job')
            .setDescription('Job to run')
            .setRequired(true)
            .addChoices(
              { name: 'Build + typecheck', value: 'build' },
              { name: 'Self check (typecheck + build)', value: 'self-check' },
              { name: 'Self update (git pull + build)', value: 'self-update' },
              { name: 'Restart Discord service', value: 'restart-discord-service' },
              { name: 'Full self refresh', value: 'full-self-refresh' },
              { name: 'Agent loop 30m', value: 'agent-loop-30m' },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('deep')
        .setDescription('Run a 30m agent deep loop and report back')
        .addStringOption(opt =>
          opt.setName('task')
            .setDescription('Deep task prompt')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('model')
            .setDescription('Optional model override')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show background job status')
        .addStringOption(opt =>
          opt.setName('job_id')
            .setDescription('Optional job ID')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a queued/running background job')
        .addStringOption(opt =>
          opt.setName('job_id')
            .setDescription('Job ID to cancel')
            .setRequired(true)
        )
    ),
  new ContextMenuCommandBuilder()
    .setName('Ask Claude')
    .setType(ApplicationCommandType.Message),
];

/**
 * Register the prepared Discord application commands using the configured application (and optional guild) settings.
 *
 * When a guild ID is configured, commands are registered for that guild; otherwise commands are registered globally.
 * Logs the count of registered commands on success and rethrows any error encountered during registration.
 *
 * @throws The underlying error if command registration fails
 */
export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(discordConfig.DISCORD_BOT_TOKEN);

  const commandData = commands.map(cmd => cmd.toJSON());

  try {
    if (discordConfig.DISCORD_GUILD_ID) {
      // Guild-scoped: instant update
      await rest.put(
        Routes.applicationGuildCommands(
          discordConfig.DISCORD_APPLICATION_ID,
          discordConfig.DISCORD_GUILD_ID
        ),
        { body: commandData },
      );
      console.log(`[Discord] Registered ${commandData.length} guild commands`);
    } else {
      // Global: may take up to an hour to propagate
      await rest.put(
        Routes.applicationCommands(discordConfig.DISCORD_APPLICATION_ID),
        { body: commandData },
      );
      console.log(`[Discord] Registered ${commandData.length} global commands`);
    }
  } catch (error) {
    console.error('[Discord] Failed to register commands:', error);
    throw error;
  }
}