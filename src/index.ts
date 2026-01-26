import { createBot } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Prevent system sleep on macOS
  preventSleep();

  const bot = await createBot();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n👋 Shutting down...');
    allowSleep();
    stopCleanup();
    bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start the bot
  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot started as @${botInfo.username}`);
      console.log('📱 Send /start in Telegram to begin');
    },
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
