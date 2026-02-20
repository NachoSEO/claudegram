/**
 * OpenAI OAuth token management for ChatGPT Pro subscription auth.
 *
 * Uses the Codex CLI's public OAuth PKCE flow to authenticate with
 * the user's ChatGPT Pro account. Tokens are stored locally and
 * refreshed automatically before expiry.
 *
 * This allows using your Pro subscription quota instead of API credits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import OpenAI from 'openai';
import { z } from 'zod';

/** OpenAI's public Codex CLI OAuth client ID. */
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com/oauth';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = 'openid profile email offline_access';

const TOKEN_FILE = path.join(os.homedir(), '.claudegram', 'openai-auth.json');
/** Refresh when token expires within this many ms. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
  chatgpt_account_id: z.string(),
});

type StoredTokens = z.infer<typeof tokenSchema>;

// ---------------------------------------------------------------------------
//  Token persistence
// ---------------------------------------------------------------------------

function loadStoredTokens(): StoredTokens | undefined {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return undefined;
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const result = tokenSchema.safeParse(raw);
    if (!result.success) {
      console.warn('[OpenAI Auth] Invalid token file, ignoring:', result.error.message);
      return undefined;
    }
    return result.data;
  } catch {
    return undefined;
  }
}

function saveTokens(tokens: StoredTokens): void {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
//  PKCE helpers
// ---------------------------------------------------------------------------

function generatePKCE(): { verifier: string; challenge: string } {
  const bytes = crypto.randomBytes(32);
  const verifier = bytes.toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

function extractAccountId(idToken: string): string {
  const parts = idToken.split('.');
  if (parts.length < 2) throw new Error('Invalid id_token: not a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const authClaim = payload['https://api.openai.com/auth'];
  if (!authClaim?.chatgpt_account_id) {
    throw new Error('JWT missing chatgpt_account_id claim');
  }
  return authClaim.chatgpt_account_id as string;
}

// ---------------------------------------------------------------------------
//  Token exchange & refresh
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

async function exchangeCode(code: string, codeVerifier: string): Promise<StoredTokens> {
  const response = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = await response.json() as TokenResponse;
  const accountId = extractAccountId(data.id_token);

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    chatgpt_account_id: accountId,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const response = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = await response.json() as TokenResponse;
  const accountId = extractAccountId(data.id_token);

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    chatgpt_account_id: accountId,
  };
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/** Cached tokens in memory to avoid re-reading file on every request. */
let cachedTokens: StoredTokens | undefined;

/**
 * Check if OAuth tokens exist and are loadable.
 */
export function hasOAuthTokens(): boolean {
  if (cachedTokens) return true;
  cachedTokens = loadStoredTokens();
  return cachedTokens !== undefined;
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns undefined if no tokens are stored.
 */
export async function getValidTokens(): Promise<StoredTokens | undefined> {
  if (!cachedTokens) {
    cachedTokens = loadStoredTokens();
  }
  if (!cachedTokens) return undefined;

  // Refresh if within buffer of expiry
  if (Date.now() >= cachedTokens.expires_at - REFRESH_BUFFER_MS) {
    console.log('[OpenAI Auth] Token expiring soon, refreshing...');
    try {
      cachedTokens = await refreshAccessToken(cachedTokens.refresh_token);
      saveTokens(cachedTokens);
      console.log('[OpenAI Auth] Token refreshed successfully');
    } catch (err) {
      console.error('[OpenAI Auth] Token refresh failed:', err instanceof Error ? err.message : err);
      // Clear cached tokens — force re-login
      cachedTokens = undefined;
      return undefined;
    }
  }

  return cachedTokens;
}

/**
 * Create an OpenAI client authenticated with the user's Pro subscription.
 * Returns undefined if no OAuth tokens are available.
 */
export async function getAuthenticatedClient(): Promise<OpenAI | undefined> {
  const tokens = await getValidTokens();
  if (!tokens) return undefined;

  return new OpenAI({
    apiKey: tokens.access_token,
    defaultHeaders: {
      'Chatgpt-Account-Id': tokens.chatgpt_account_id,
    },
  });
}

/**
 * Clear stored tokens (logout).
 */
export function clearOAuthTokens(): void {
  cachedTokens = undefined;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
//  Interactive OAuth login (used by CLI script)
// ---------------------------------------------------------------------------

/**
 * Start the OAuth PKCE login flow.
 * Opens a local HTTP server on port 1455, returns the auth URL for the user
 * to open in their browser, and resolves when the callback is received.
 */
export function startOAuthLogin(): Promise<StoredTokens> {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl =
    `${AUTH_BASE}/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Auth failed</h1><p>${error}</p><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Invalid callback</h1><p>Missing code or state mismatch.</p>');
        server.close();
        reject(new Error('Invalid OAuth callback: missing code or state mismatch'));
        return;
      }

      try {
        const tokens = await exchangeCode(code, verifier);
        saveTokens(tokens);
        cachedTokens = tokens;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authenticated!</h1>' +
          '<p>Your ChatGPT Pro account is now linked to Claudegram.</p>' +
          '<p>You can close this tab.</p>',
        );
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Token exchange failed</h1><p>${err instanceof Error ? err.message : err}</p>`);
        server.close();
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log('\n=== OpenAI Pro Account Login ===\n');
      console.log('Open this URL in your browser:\n');
      console.log(`  ${authUrl}\n`);
      console.log('Waiting for authentication...\n');
      console.log('(If on a VPS, use: ssh -L 1455:localhost:1455 user@server)\n');
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start auth server: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth login timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}
