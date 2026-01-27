import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import TurndownService from 'turndown';
import { config } from '../config.js';

export interface FreediumArticle {
  title: string;
  author: string;
  markdown: string;
  url: string;
}

// Known Medium publication domains (custom domains that host Medium content)
const KNOWN_MEDIUM_DOMAINS = new Set([
  'medium.com',
  'towardsdatascience.com',
  'betterprogramming.pub',
  'levelupgaming.com',
  'javascript.plainenglish.io',
  'python.plainenglish.io',
  'blog.devgenius.io',
  'medium.datadriveninvestor.com',
  'uxdesign.cc',
  'entrepreneurshandbook.co',
  'betterhumans.pub',
  'codeburst.io',
  'itnext.io',
  'proandroiddev.com',
  'infosecwriteups.com',
  'blog.stackademic.com',
  'aws.plainenglish.io',
]);

// Simple rate limiter
let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const delay = config.FREEDIUM_RATE_LIMIT_MS;
  if (elapsed < delay) {
    await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Check whether a URL points to a Medium article.
 */
export function isMediumUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (KNOWN_MEDIUM_DOMAINS.has(host)) return true;
    // Subdomain of medium.com (e.g. blog.medium.com)
    if (host.endsWith('.medium.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Convert a Medium URL to its Freedium mirror equivalent.
 */
export function toFreediumUrl(url: string): string {
  const parsed = new URL(url);
  // Freedium expects the original full URL as the path
  return `https://${config.FREEDIUM_HOST}/${parsed.href}`;
}

/**
 * Fetch a Medium article via Freedium and convert to Markdown.
 */
export async function fetchMediumArticle(url: string): Promise<FreediumArticle> {
  await rateLimit();

  const freediumUrl = toFreediumUrl(url);

  const response = await fetch(freediumUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(config.MEDIUM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Freedium returned HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Extract title
  const title = $('h1.title').first().text().trim()
    || $('h1').first().text().trim()
    || $('title').text().trim()
    || 'Untitled';

  // Extract author
  const author = $('a.author-link').first().text().trim()
    || $('.author').first().text().trim()
    || 'Unknown';

  // Extract main content
  const mainContent = $('div.main-content').first();
  if (mainContent.length === 0) {
    // Fallback: try the article body
    const fallback = $('article').first();
    if (fallback.length === 0) {
      throw new Error('Could not find article content on Freedium page');
    }
    return convertToArticle($, fallback, title, author, url);
  }

  return convertToArticle($, mainContent, title, author, url);
}

function convertToArticle(
  $: cheerio.CheerioAPI,
  contentEl: cheerio.Cheerio<AnyNode>,
  title: string,
  author: string,
  url: string,
): FreediumArticle {
  // Remove scripts, styles, nav elements from content
  contentEl.find('script, style, nav, .sidebar, .footer').remove();

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // Preserve code blocks
  turndown.addRule('pre', {
    filter: 'pre',
    replacement: (_content, node) => {
      const text = (node as { textContent?: string }).textContent || '';
      return `\n\`\`\`\n${text}\n\`\`\`\n`;
    },
  });

  const contentHtml = contentEl.html() || '';
  const markdown = turndown.turndown(contentHtml).trim();

  return { title, author, markdown, url };
}
