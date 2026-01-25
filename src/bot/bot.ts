import { Bot } from 'grammy';
import { config } from '../config.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import {
  handleStart,
  handleNew,
  handleProject,
  handleNewProject,
  handleStatus,
  handleMode,
} from './handlers/command.handler.js';
import { handleMessage } from './handlers/message.handler.js';

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Apply auth middleware to all updates
  bot.use(authMiddleware);

  // Bot command handlers
  bot.command('start', handleStart);
  bot.command('new', handleNew);
  bot.command('project', handleProject);
  bot.command('newproject', handleNewProject);
  bot.command('status', handleStatus);
  bot.command('mode', handleMode);

  // Handle regular text messages
  bot.on('message:text', handleMessage);

  // Error handler with connection diagnostics
  bot.catch((err) => {
    const error = err.error as any;

    // Check for common network/connection errors
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET' || error?.code === 'ENOTFOUND') {
      console.error(`🔌 Network error (${error.code}): Connection issue detected`);
      console.error('   This may be due to laptop sleep/wake or network connectivity');
      console.error('   The bot will automatically retry...');
    } else if (error?.message?.includes('conflict')) {
      console.error('⚠️  Bot conflict: Another instance may be running');
    } else {
      console.error('❌ Bot error:', error);
    }
  });

  return bot;
}
