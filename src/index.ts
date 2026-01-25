import { createBot } from './bot/bot.js';
import { config } from './config.js';

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  const bot = createBot();

  // Connection monitor to detect sleep/wake cycles
  let lastPollTime = Date.now();
  const POLL_CHECK_INTERVAL = 15000; // Check every 15 seconds

  const connectionMonitor = setInterval(() => {
    const now = Date.now();
    const timeSinceLastPoll = now - lastPollTime;

    // If more than 60 seconds since last update, we might have been asleep
    if (timeSinceLastPoll > 60000) {
      console.log(`⚠️  Connection gap detected (${Math.round(timeSinceLastPoll / 1000)}s) - laptop may have been sleeping`);
      console.log('🔄 Polling should resume automatically...');
    }

    lastPollTime = now;
  }, POLL_CHECK_INTERVAL);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n👋 Shutting down...');
    clearInterval(connectionMonitor);
    bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start the bot with optimized polling for sleep/wake scenarios
  await bot.start({
    // Reduce polling timeout for faster wake-up detection after laptop sleep
    timeout: config.POLLING_TIMEOUT, // Configurable timeout (default 10s vs default 30s)
    limit: 100, // Process up to 100 updates at once
    allowed_updates: ['message', 'callback_query'],
    onStart: (botInfo) => {
      console.log(`✅ Bot started as @${botInfo.username}`);
      console.log('📱 Send /start in Telegram to begin');
      console.log(`⏱️  Polling timeout: ${config.POLLING_TIMEOUT}s (shorter = faster wake-up detection)`);
    },
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
