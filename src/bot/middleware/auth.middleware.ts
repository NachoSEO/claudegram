import { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

/**
 * Log authentication attempt for security auditing.
 * Avoids logging message content to protect privacy.
 */
function logAuthAttempt(
  success: boolean,
  userId: number | undefined,
  username: string | undefined,
  chatType: string | undefined
): void {
  const timestamp = new Date().toISOString();
  const userInfo = userId ? `user:${userId}` : 'user:unknown';
  const usernameInfo = username ? `@${username}` : '';
  const status = success ? 'ALLOWED' : 'DENIED';
  console.log(`[auth] ${timestamp} ${status} ${userInfo} ${usernameInfo} chat:${chatType || 'unknown'}`);
}

export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const chatType = ctx.chat?.type;

  if (!userId) {
    logAuthAttempt(false, undefined, undefined, chatType);
    return;
  }

  if (!config.ALLOWED_USER_IDS.includes(userId)) {
    logAuthAttempt(false, userId, username, chatType);
    await ctx.reply('⛔ You are not authorized to use this bot.');
    return;
  }

  logAuthAttempt(true, userId, username, chatType);
  await next();
}
