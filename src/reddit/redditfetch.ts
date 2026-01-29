/**
 * redditfetch — Native TypeScript module for fetching Reddit posts, comments,
 * subreddits, and user profiles as markdown or JSON.
 *
 * Replaces the external Python subprocess (redditfetch.py) to eliminate
 * Python runtime overhead and improve latency.
 */

import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OAUTH_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

const SHARE_LINK_RE = /reddit\.com\/r\/\w+\/s\/(\w+)/;
const POST_URL_RE =
  /(?:old\.|www\.|new\.)?reddit\.com\/r\/(?<subreddit>\w+)\/comments\/(?<post_id>\w+)/;
const SUBREDDIT_URL_RE =
  /(?:old\.|www\.|new\.)?reddit\.com\/r\/(?<subreddit>\w+)\/?(?:\?.*)?$/;
const USER_URL_RE =
  /(?:old\.|www\.|new\.)?reddit\.com\/u(?:ser)?\/(?<username>[\w-]+)/;
const BARE_SUBREDDIT_RE = /^r\/(?<subreddit>\w+)$/;
const BARE_USER_RE = /^u\/(?<username>[\w-]+)$/;
const BARE_ID_RE = /^[a-z0-9]{5,10}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ParsedTarget {
  type: 'post' | 'subreddit' | 'user' | 'share_link';
  subreddit?: string;
  post_id?: string;
  username?: string;
  url?: string;
}

export interface RedditComment {
  type: 'comment' | 'more';
  depth: number;
  author?: string;
  score?: number;
  body?: string;
  created_utc?: number;
  id?: string;
  count?: number;
}

export interface PostResult {
  post: Record<string, unknown>;
  comments: RedditComment[];
}

export interface SubredditResult {
  subreddit: string;
  sort: string;
  posts: Record<string, unknown>[];
}

export interface UserResult {
  username: string;
  items: Record<string, unknown>[];
}

export interface RedditFetchOptions {
  format?: 'markdown' | 'json';
  sort?: string;
  limit?: number;
  depth?: number;
  timeFilter?: string;
}

// ---------------------------------------------------------------------------
// Token caching (module-level singleton)
// ---------------------------------------------------------------------------
let cachedToken: { accessToken: string; userAgent: string; expiresAt: number } | null = null;

export function clearTokenCache(): void {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
function getCredentials(): {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
} {
  const clientId = config.REDDIT_CLIENT_ID;
  const clientSecret = config.REDDIT_CLIENT_SECRET;
  const username = config.REDDIT_USERNAME;
  const password = config.REDDIT_PASSWORD;

  const missing: string[] = [];
  if (!clientId) missing.push('REDDIT_CLIENT_ID');
  if (!clientSecret) missing.push('REDDIT_CLIENT_SECRET');
  if (!username) missing.push('REDDIT_USERNAME');
  if (!password) missing.push('REDDIT_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Missing Reddit credentials: ${missing.join(', ')}. ` +
        `Set them in claudegram's .env file.`
    );
  }

  return { clientId: clientId!, clientSecret: clientSecret!, username: username!, password: password! };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
async function authenticate(): Promise<{ accessToken: string; userAgent: string }> {
  const creds = getCredentials();
  const userAgent = `linux:redditfetch.ts.v1 (by u/${creds.username})`;

  const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'password',
    username: creds.username,
    password: creds.password,
    scope: 'read',
  });

  const resp = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Reddit OAuth failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const accessToken = data.access_token as string | undefined;
  if (!accessToken) {
    throw new Error(`Reddit OAuth failed: ${JSON.stringify(data)}`);
  }

  const expiresIn = (data.expires_in as number) || 86400;
  cachedToken = {
    accessToken,
    userAgent,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return { accessToken, userAgent };
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  // Reuse cached token if >60s remaining
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return {
      Authorization: `bearer ${cachedToken.accessToken}`,
      'User-Agent': cachedToken.userAgent,
    };
  }

  const { accessToken, userAgent } = await authenticate();
  return {
    Authorization: `bearer ${accessToken}`,
    'User-Agent': userAgent,
  };
}

// ---------------------------------------------------------------------------
// URL Parsing
// ---------------------------------------------------------------------------
export function parseRedditUrl(raw: string): ParsedTarget | null {
  raw = raw.trim();

  // Share link (/r/sub/s/CODE)
  if (SHARE_LINK_RE.test(raw)) {
    return { type: 'share_link', url: raw };
  }

  // Full post URL
  let m = POST_URL_RE.exec(raw);
  if (m?.groups) {
    return { type: 'post', subreddit: m.groups.subreddit, post_id: m.groups.post_id };
  }

  // Full subreddit URL (must come after post URL check)
  m = SUBREDDIT_URL_RE.exec(raw);
  if (m?.groups) {
    return { type: 'subreddit', subreddit: m.groups.subreddit };
  }

  // Full user URL
  m = USER_URL_RE.exec(raw);
  if (m?.groups) {
    return { type: 'user', username: m.groups.username };
  }

  // Bare r/subreddit
  m = BARE_SUBREDDIT_RE.exec(raw);
  if (m?.groups) {
    return { type: 'subreddit', subreddit: m.groups.subreddit };
  }

  // Bare u/user
  m = BARE_USER_RE.exec(raw);
  if (m?.groups) {
    return { type: 'user', username: m.groups.username };
  }

  // Bare post ID (alphanumeric, 5-10 chars)
  if (BARE_ID_RE.test(raw)) {
    return { type: 'post', post_id: raw };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Share link resolution
// ---------------------------------------------------------------------------
async function resolveShareLink(
  url: string,
  userAgent: string
): Promise<ParsedTarget | null> {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const finalUrl = resp.url;
    const parsed = parseRedditUrl(finalUrl);
    if (parsed && parsed.type === 'post') {
      return parsed;
    }
  } catch (err) {
    console.warn(`[redditfetch] Share link resolution failed for: ${url}`, err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------
async function fetchPost(
  headers: Record<string, string>,
  postId: string,
  subreddit?: string,
  depth = 5
): Promise<PostResult> {
  const url = subreddit
    ? `${API_BASE}/r/${subreddit}/comments/${postId}.json`
    : `${API_BASE}/comments/${postId}.json`;

  const params = new URLSearchParams({
    depth: String(depth),
    limit: '500',
    sort: 'best',
  });

  const resp = await fetch(`${url}?${params}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Reddit API error: HTTP ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as Array<{
    data: { children: Array<{ data: Record<string, unknown>; kind: string }> };
  }>;

  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new Error(`Reddit API returned no post for id ${postId}`);
  }
  const commentsRaw = data?.[1]?.data?.children ?? [];
  const comments = flattenComments(commentsRaw, depth);

  return { post, comments };
}

async function fetchSubreddit(
  headers: Record<string, string>,
  subreddit: string,
  sort = 'hot',
  limit = 25,
  timeFilter?: string
): Promise<SubredditResult> {
  const url = `${API_BASE}/r/${subreddit}/${sort}.json`;
  const params = new URLSearchParams({ limit: String(limit) });
  if (sort === 'top' && timeFilter) {
    params.set('t', timeFilter);
  }

  const resp = await fetch(`${url}?${params}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Reddit API error: HTTP ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    data: { children: Array<{ data: Record<string, unknown> }> };
  };

  const children = data?.data?.children;
  const posts = (Array.isArray(children) ? children : [])
    .filter((child) => child?.data)
    .map((child) => child.data);
  return { subreddit, sort, posts };
}

async function fetchUser(
  headers: Record<string, string>,
  username: string,
  sort = 'new',
  limit = 25,
  timeFilter?: string
): Promise<UserResult> {
  const url = `${API_BASE}/user/${username}/overview.json`;
  const params = new URLSearchParams({ limit: String(limit), sort });
  if (sort === 'top' && timeFilter) {
    params.set('t', timeFilter);
  }

  const resp = await fetch(`${url}?${params}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Reddit API error: HTTP ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    data: { children: Array<{ data: Record<string, unknown> }> };
  };

  const children = data?.data?.children;
  const items = (Array.isArray(children) ? children : [])
    .filter((child) => child?.data)
    .map((child) => child.data);
  return { username, items };
}

// ---------------------------------------------------------------------------
// Comment flattening
// ---------------------------------------------------------------------------
function flattenComments(
  children: Array<{ kind: string; data: Record<string, unknown> }>,
  maxDepth = 5,
  currentDepth = 0
): RedditComment[] {
  const results: RedditComment[] = [];

  for (const child of children) {
    if (child.kind === 'more') {
      const moreChildren = (child.data.children as string[]) || [];
      if (moreChildren.length > 0) {
        results.push({
          type: 'more',
          depth: currentDepth,
          count: moreChildren.length,
        });
      }
      continue;
    }

    if (child.kind !== 't1') {
      continue;
    }

    const cdata = child.data;
    results.push({
      type: 'comment',
      depth: currentDepth,
      author: (cdata.author as string) || '[deleted]',
      score: (cdata.score as number) || 0,
      body: (cdata.body as string) || '',
      created_utc: (cdata.created_utc as number) || 0,
      id: (cdata.id as string) || '',
    });

    if (currentDepth < maxDepth) {
      const replies = cdata.replies;
      if (replies && typeof replies === 'object' && !Array.isArray(replies)) {
        const repliesData = replies as { data: { children: Array<{ kind: string; data: Record<string, unknown> }> } };
        if (repliesData.data?.children) {
          results.push(
            ...flattenComments(repliesData.data.children, maxDepth, currentDepth + 1)
          );
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatTimestamp(utc: number): string {
  try {
    const d = new Date(utc * 1000);
    if (isNaN(d.getTime())) return 'unknown';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
  } catch {
    return 'unknown';
  }
}

function formatPostMarkdown(result: PostResult): string {
  const p = result.post;
  const lines: string[] = [];

  lines.push(`# ${p.title as string}`);
  lines.push('');
  lines.push(
    `**r/${p.subreddit as string}** | u/${(p.author as string) || '[deleted]'} | ` +
      `${(p.score as number) || 0} pts | ${formatTimestamp((p.created_utc as number) || 0)}`
  );
  lines.push(
    `Post ID: ${p.id as string} | ${(p.num_comments as number) || 0} comments | ` +
      `Upvote ratio: ${p.upvote_ratio ?? 'N/A'}`
  );
  lines.push(`URL: https://www.reddit.com${(p.permalink as string) || ''}`);
  lines.push('');

  const body = ((p.selftext as string) || '').trim();
  if (body) {
    lines.push('## Post Body');
    lines.push('');
    lines.push(body);
    lines.push('');
  }

  const linkUrl = (p.url as string) || '';
  if (linkUrl && !linkUrl.startsWith('https://www.reddit.com/r/')) {
    lines.push(`**Link:** ${linkUrl}`);
    lines.push('');
  }

  if (result.comments.length > 0) {
    lines.push('---');
    lines.push(`## Comments (${(p.num_comments as number) || 0})`);
    lines.push('');

    for (const c of result.comments) {
      if (c.type === 'more') {
        const indent = '  '.repeat(c.depth);
        lines.push(`${indent}*[${c.count} more replies]*`);
        lines.push('');
        continue;
      }

      const marker =
        c.depth === 0
          ? `${'  '.repeat(c.depth)}- `
          : `${'  '.repeat(c.depth)}  - `;

      lines.push(
        `${marker}**u/${c.author}** (${c.score} pts, ${formatTimestamp(c.created_utc!)}):`
      );

      const bodyIndent = '  '.repeat(c.depth + 1);
      for (const bline of (c.body || '').split('\n')) {
        lines.push(`${bodyIndent}${bline}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatSubredditMarkdown(result: SubredditResult): string {
  const lines: string[] = [];
  lines.push(`# r/${result.subreddit} — ${result.sort}`);
  lines.push('');

  result.posts.forEach((p, idx) => {
    const flair = p.link_flair_text ? ` [${p.link_flair_text}]` : '';
    lines.push(`${idx + 1}. **${p.title as string}**${flair}  `);
    lines.push(
      `   u/${(p.author as string) || '[deleted]'} | ${(p.score as number) || 0} pts | ` +
        `${(p.num_comments as number) || 0} comments | ${formatTimestamp((p.created_utc as number) || 0)}`
    );
    lines.push(`   ID: ${p.id as string} | https://www.reddit.com${(p.permalink as string) || ''}`);

    const body = ((p.selftext as string) || '').trim();
    if (body) {
      let preview = body.slice(0, 200).replace(/\n/g, ' ');
      if (body.length > 200) preview += '\u2026';
      lines.push(`   > ${preview}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

function formatUserMarkdown(result: UserResult): string {
  const lines: string[] = [];
  lines.push(`# u/${result.username} — recent activity`);
  lines.push('');

  result.items.forEach((item, idx) => {
    const kind = 'body' in item && !('title' in item) ? 'comment' : 'post';

    if (kind === 'post') {
      lines.push(`${idx + 1}. **[post]** ${(item.title as string) || '(untitled)'}`);
      lines.push(
        `   r/${(item.subreddit as string) || '?'} | ${(item.score as number) || 0} pts | ` +
          `${formatTimestamp((item.created_utc as number) || 0)}`
      );
      lines.push(
        `   ID: ${(item.id as string) || '?'} | ` +
          `https://www.reddit.com${(item.permalink as string) || ''}`
      );
    } else {
      const context = (item.link_title as string) || '(context)';
      lines.push(`${idx + 1}. **[comment]** on: ${context}`);
      lines.push(
        `   r/${(item.subreddit as string) || '?'} | ${(item.score as number) || 0} pts | ` +
          `${formatTimestamp((item.created_utc as number) || 0)}`
      );
      const body = ((item.body as string) || '').trim();
      let preview = body.slice(0, 200).replace(/\n/g, ' ');
      if (body.length > 200) preview += '\u2026';
      lines.push(`   > ${preview}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

function formatJson(result: PostResult | SubredditResult | UserResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Raw fetcher — single API call, returns raw result objects
// ---------------------------------------------------------------------------
type RawResult = PostResult | SubredditResult | UserResult;

async function redditFetchRaw(
  targets: string[],
  options: RedditFetchOptions = {}
): Promise<RawResult[]> {
  const {
    sort = 'hot',
    limit = 25,
    depth = 5,
    timeFilter,
  } = options;

  const headers = await getAuthHeaders();
  const userAgent = headers['User-Agent'];
  const results: RawResult[] = [];

  for (const raw of targets) {
    let parsed = parseRedditUrl(raw);

    if (!parsed) {
      throw new Error(`Could not parse target: ${raw}`);
    }

    // Resolve share links
    if (parsed.type === 'share_link') {
      const resolved = await resolveShareLink(raw, userAgent);
      if (!resolved) {
        throw new Error(`Could not resolve share link: ${raw}`);
      }
      parsed = resolved;
    }

    if (parsed.type === 'post') {
      results.push(await fetchPost(headers, parsed.post_id!, parsed.subreddit, depth));
    } else if (parsed.type === 'subreddit') {
      results.push(await fetchSubreddit(headers, parsed.subreddit!, sort, limit, timeFilter));
    } else if (parsed.type === 'user') {
      results.push(await fetchUser(headers, parsed.username!, sort, limit, timeFilter));
    } else {
      throw new Error(`Unknown target type for: ${raw}`);
    }
  }

  if (results.length === 0) {
    throw new Error('No results.');
  }

  return results;
}

function formatResults(results: RawResult[], format: 'markdown' | 'json'): string {
  const formatted = results.map((r) => {
    if (format === 'json') return formatJson(r);
    if ('post' in r) return formatPostMarkdown(r as PostResult);
    if ('subreddit' in r) return formatSubredditMarkdown(r as SubredditResult);
    return formatUserMarkdown(r as UserResult);
  });

  if (format === 'json' && formatted.length > 1) {
    return `[\n${formatted.join(',\n')}\n]`;
  }
  const separator = format === 'markdown' ? '\n\n---\n\n' : '\n';
  return formatted.join(separator);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function redditFetch(
  targets: string[],
  options: RedditFetchOptions = {}
): Promise<string> {
  const format = options.format || 'markdown';
  const raw = await redditFetchRaw(targets, options);
  return formatResults(raw, format);
}

/**
 * Fetch once, return both markdown and JSON strings.
 * Avoids a second API call for the large-thread JSON fallback.
 */
export async function redditFetchBoth(
  targets: string[],
  options: RedditFetchOptions = {}
): Promise<{ markdown: string; json: string }> {
  const raw = await redditFetchRaw(targets, options);
  return {
    markdown: formatResults(raw, 'markdown'),
    json: formatResults(raw, 'json'),
  };
}
