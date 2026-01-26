import { Bot } from 'grammy';
import { config } from '../config.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import {
  handleStart,
  handleClear,
  handleClearCallback,
  handleProject,
  handleNewProject,
  handleStatus,
  handleMode,
  handleModeCallback,
  handleTTS,
  handleTTSCallback,
  handlePing,
  handleCancel,
  handleCommands,
  handleModelCommand,
  handleModelCallback,
  handlePlan,
  handleExplore,
  handleResume,
  handleResumeCallback,
  handleContinue,
  handleLoop,
  handleSessions,
  handleFile,
  handleTelegraph,
  handleReddit,
} from './handlers/command.handler.js';
import { handleMessage } from './handlers/message.handler.js';
import { handleVoice } from './handlers/voice.handler.js';
import { handlePhoto, handleImageDocument } from './handlers/photo.handler.js';

export async function createBot(): Promise<Bot> {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Register command menu for autocomplete (non-blocking)
  bot.api.setMyCommands([
    { command: 'start', description: '🚀 Show help and getting started' },
    { command: 'project', description: '📁 Set working directory' },
    { command: 'status', description: '📊 Show current session status' },
    { command: 'clear', description: '🗑️ Clear conversation history' },
    { command: 'cancel', description: '⏹️ Cancel current request' },
    { command: 'file', description: '📎 Download a file from project' },
    { command: 'telegraph', description: '📄 View markdown with Instant View' },
    { command: 'model', description: '🤖 Switch AI model' },
    { command: 'mode', description: '⚙️ Toggle streaming mode' },
    { command: 'tts', description: '🔊 Toggle voice replies' },
    { command: 'plan', description: '📋 Start planning mode' },
    { command: 'explore', description: '🔍 Explore codebase' },
    { command: 'loop', description: '🔄 Run in loop mode' },
    { command: 'sessions', description: '📚 View saved sessions' },
    { command: 'resume', description: '▶️ Resume a session' },
    { command: 'reddit', description: '📡 Fetch Reddit posts & subreddits' },
    { command: 'commands', description: '📜 List all commands' },
  ]).then(() => {
    console.log('📋 Command menu registered');
  }).catch((err) => {
    console.warn('⚠️ Failed to register commands:', err.message);
  });

  // Apply auth middleware to all updates
  bot.use(authMiddleware);

  // Bot command handlers
  bot.command('start', handleStart);
  bot.command('clear', handleClear);
  bot.command('project', handleProject);
  bot.command('newproject', handleNewProject);
  bot.command('status', handleStatus);
  bot.command('mode', handleMode);
  bot.command('tts', handleTTS);

  // New commands
  bot.command('ping', handlePing);
  bot.command('cancel', handleCancel);
  bot.command('commands', handleCommands);
  bot.command('model', handleModelCommand);
  bot.command('plan', handlePlan);
  bot.command('explore', handleExplore);

  // Session resume commands
  bot.command('resume', handleResume);
  bot.command('continue', handleContinue);
  bot.command('sessions', handleSessions);

  // Loop mode
  bot.command('loop', handleLoop);

  // File commands
  bot.command('file', handleFile);
  bot.command('telegraph', handleTelegraph);

  // Reddit
  bot.command('reddit', handleReddit);

  // Callback query handler for inline keyboards
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('resume:')) {
      await handleResumeCallback(ctx);
    } else if (data.startsWith('model:')) {
      await handleModelCallback(ctx);
    } else if (data.startsWith('mode:')) {
      await handleModeCallback(ctx);
    } else if (data.startsWith('tts:')) {
      await handleTTSCallback(ctx);
    } else if (data.startsWith('clear:')) {
      await handleClearCallback(ctx);
    }
  });

  // Handle voice messages
  bot.on('message:voice', handleVoice);

  // Handle images
  bot.on('message:photo', handlePhoto);
  bot.on('message:document', handleImageDocument);

  // Handle regular text messages
  bot.on('message:text', handleMessage);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
