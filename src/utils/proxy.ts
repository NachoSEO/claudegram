import * as fs from 'fs';
import { ProxyAgent } from 'undici';
import { config } from '../config.js';

let proxyList: string[] = [];
let proxyIndex = 0;

/**
 * Load proxies from the configured proxy list file.
 * Reuses YTDLP_PROXY_LIST_PATH — same residential proxy pool.
 */
function ensureLoaded(): void {
  if (proxyList.length > 0) return;

  const listPath = config.YTDLP_PROXY_LIST_PATH;
  if (!listPath) return;

  try {
    if (fs.existsSync(listPath)) {
      proxyList = fs.readFileSync(listPath, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      console.log(`[proxy] Loaded ${proxyList.length} residential proxies`);
    }
  } catch (err) {
    console.warn('[proxy] Failed to load proxy list:', err);
  }
}

/**
 * Get the next proxy URL (round-robin).
 */
export function getNextProxy(): string | null {
  ensureLoaded();
  if (proxyList.length === 0) return null;
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;
  return proxy;
}

/**
 * Create an undici ProxyAgent dispatcher for use with fetch().
 * Returns null if no proxies are available.
 */
const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

export function getProxyDispatcher(): ProxyAgent | null {
  const proxyUrl = getNextProxy();
  if (!proxyUrl) return null;

  try {
    const parsed = new URL(proxyUrl);
    if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
      console.warn(`[proxy] Rejected invalid proxy protocol: ${parsed.protocol}`);
      return null;
    }
  } catch {
    console.warn('[proxy] Rejected malformed proxy URL');
    return null;
  }

  return new ProxyAgent(proxyUrl);
}
