/**
 * Maps Discord snowflake IDs (64-bit strings) to negative numbers
 * for compatibility with existing Maps that use number keys.
 *
 * Telegram IDs are always positive. Discord IDs become negative. Zero collision.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function discordChatId(snowflake: string): number {
  return -Number(BigInt(snowflake) % MAX_SAFE);
}
