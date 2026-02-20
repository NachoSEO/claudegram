#!/usr/bin/env npx tsx
/**
 * OpenAI Pro Account Login — OAuth PKCE flow.
 *
 * Usage:
 *   npx tsx scripts/openai-login.ts
 *
 * On a VPS, first set up SSH port forwarding:
 *   ssh -L 1455:localhost:1455 user@your-server
 *   Then run this script on the server.
 *
 * Opens a browser auth flow with your ChatGPT Pro account.
 * Tokens are saved to ~/.claudegram/openai-auth.json and used
 * automatically by the bot (no API key needed).
 */

import { startOAuthLogin } from '../src/providers/openai-auth.js';

async function main() {
  try {
    const tokens = await startOAuthLogin();
    console.log('Login successful!');
    console.log(`  Account ID: ${tokens.chatgpt_account_id}`);
    console.log(`  Expires: ${new Date(tokens.expires_at).toLocaleString()}`);
    console.log('\nTokens saved to ~/.claudegram/openai-auth.json');
    console.log('The bot will use your Pro subscription automatically.');
    process.exit(0);
  } catch (err) {
    console.error('\nLogin failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
