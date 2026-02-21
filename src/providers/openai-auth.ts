/**
 * OpenAI OAuth token management for ChatGPT Pro subscription auth.
 *
 * Uses the Codex CLI's public OAuth PKCE flow to authenticate with
 * the user's ChatGPT Pro account. The access_token is used directly
 * as a bearer token with the Codex backend URL — no API key exchange.
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

/** Codex-mode base URL for ChatGPT Pro subscription auth. */
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

const TOKEN_FILE = path.join(os.homedir(), '.claudegram', 'openai-auth.json');
/** Refresh when token expires within this many ms. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

const tokenSchema = z.object({
  /** OAuth access token — used directly as bearer. */
  access_token: z.string(),
  /** OAuth refresh token for obtaining new access tokens. */
  refresh_token: z.string(),
  /** Expiry timestamp (ms). */
  expires_at: z.number(),
  /** ChatGPT account ID from the JWT claims. */
  chatgpt_account_id: z.string(),
});

type StoredTokens = z.infer<typeof tokenSchema>;

// ---------------------------------------------------------------------------
//  Token persistence
// ---------------------------------------------------------------------------

/** Path to the Codex CLI's auth file — used as fallback token source. */
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

const codexAuthSchema = z.object({
  auth_mode: z.string(),
  tokens: z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    account_id: z.string(),
  }),
});

function loadStoredTokens(): StoredTokens | undefined {
  // Try our own token file first
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      const result = tokenSchema.safeParse(raw);
      if (result.success) return result.data;
      console.warn('[OpenAI Auth] Invalid token file, ignoring:', result.error.message);
    }
  } catch {
    // fall through to Codex CLI
  }

  // Fall back to Codex CLI auth file
  try {
    if (!fs.existsSync(CODEX_AUTH_FILE)) return undefined;
    const raw = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8'));
    const result = codexAuthSchema.safeParse(raw);
    if (!result.success) return undefined;
    if (result.data.auth_mode !== 'chatgpt') return undefined;

    console.log('[OpenAI Auth] Using Codex CLI tokens from ~/.codex/auth.json');
    const tokens: StoredTokens = {
      access_token: result.data.tokens.access_token,
      refresh_token: result.data.tokens.refresh_token,
      // Access tokens from Codex CLI have ~10 day expiry, set a conservative estimate
      expires_at: Date.now() + 8 * 24 * 60 * 60 * 1000,
      chatgpt_account_id: result.data.tokens.account_id,
    };
    // Save to our own file so we can track refresh independently
    saveTokens(tokens);
    return tokens;
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

interface OAuthTokenResponse {
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

  const data = await response.json() as OAuthTokenResponse;
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
      scope: 'openid profile email',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = await response.json() as OAuthTokenResponse;
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
 * Get valid tokens, refreshing if needed.
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
      cachedTokens = undefined;
      return undefined;
    }
  }

  return cachedTokens;
}

/**
 * Create an OpenAI client authenticated with the user's Pro subscription.
 * Uses the Codex backend URL with bearer token — no API key needed.
 *
 * The Codex backend requires `store: false` on all responses requests,
 * so we wrap fetch to inject that into every request body.
 *
 * Returns undefined if no OAuth tokens are available.
 */
export async function getAuthenticatedClient(): Promise<OpenAI | undefined> {
  const tokens = await getValidTokens();
  if (!tokens) return undefined;

  return new OpenAI({
    apiKey: tokens.access_token,
    baseURL: CODEX_BASE_URL,
    defaultHeaders: {
      'chatgpt-account-id': tokens.chatgpt_account_id,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'pi',
    },
    fetch: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedUrl = (() => {
        try {
          if (url instanceof Request) return new URL(url.url);
          if (url instanceof URL) return url;
          return new URL(url, CODEX_BASE_URL);
        } catch {
          return undefined;
        }
      })();

      const pathname = parsedUrl?.pathname ?? '';
      const isResponsesLikeEndpoint =
        pathname.includes('/responses') || pathname.includes('/completions');

      // Codex backend rejects store: true on responses/completions payloads.
      if (isResponsesLikeEndpoint && init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          body.store = false;
          init = { ...init, body: JSON.stringify(body) };
        } catch {
          // not JSON, pass through
        }
      }
      return fetch(url, init);
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
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
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
