import Telegraph from 'telegra.ph';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

// Zod schema for Telegraph account file
const telegraphAccountSchema = z.object({
  access_token: z.string().min(1),
  auth_url: z.string(),
  short_name: z.string(),
});

// Telegraph client singleton
let telegraphClient: Telegraph | null = null;
let telegraphAccount: z.infer<typeof telegraphAccountSchema> | null = null;

// Thresholds for when to use Telegraph vs inline
const TELEGRAPH_THRESHOLD = 2500; // Use Telegraph for messages longer than this
const TABLE_PATTERN = /\|.*\|.*\|/; // Detect markdown tables

/**
 * Initialize Telegraph account (creates one if needed)
 */
export async function initTelegraph(): Promise<void> {
  try {
    const accountFile = path.join(process.cwd(), '.telegraph-account.json');

    if (fs.existsSync(accountFile)) {
      // Load existing account with schema validation
      const raw = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
      const result = telegraphAccountSchema.safeParse(raw);

      if (result.success) {
        telegraphClient = new Telegraph(result.data.access_token);
        telegraphAccount = result.data;
        console.log('[Telegraph] Loaded existing account');
      } else {
        console.warn('[Telegraph] Invalid account file, creating new account:', result.error.message);
        // Fall through to create new account
      }
    }

    if (!telegraphClient) {
      // Create new account - need empty token first
      telegraphClient = new Telegraph('');

      const account = await telegraphClient.createAccount(
        'Claudegram',
        'Claude Agent',
        'https://github.com/anthropics/claude-code'
      );

      telegraphAccount = {
        access_token: account.access_token!,
        auth_url: account.auth_url!,
        short_name: account.short_name
      };

      // Set the token after creation
      telegraphClient.token = account.access_token!;

      // Save for future use
      fs.writeFileSync(accountFile, JSON.stringify(telegraphAccount, null, 2), { mode: 0o600 });
      console.log('[Telegraph] Created new account');
    }
  } catch (error) {
    console.error('[Telegraph] Failed to initialize:', error);
  }
}

/**
 * Check if content should use Telegraph (long content or has tables)
 */
export function shouldUseTelegraph(content: string): boolean {
  // Use Telegraph for long content
  if (content.length > TELEGRAPH_THRESHOLD) {
    return true;
  }

  // Use Telegraph if content has tables (not supported in MarkdownV2)
  if (TABLE_PATTERN.test(content)) {
    return true;
  }

  return false;
}

/**
 * Telegraph Node type - matches the library's Node type
 */
type TelegraphTag = 'a' | 'aside' | 'b' | 'blockquote' | 'br' | 'code' | 'em' |
  'figcaption' | 'figure' | 'h3' | 'h4' | 'hr' | 'i' | 'iframe' | 'img' |
  'li' | 'ol' | 'p' | 'pre' | 's' | 'strong' | 'u' | 'ul' | 'video';

type TelegraphNode = string | {
  tag: TelegraphTag;
  attrs?: { href?: string; src?: string };
  children?: TelegraphNode[];
};

/**
 * Convert markdown to Telegraph Node format
 * Supported tags: a, aside, b, blockquote, br, code, em, figcaption, figure,
 * h3, h4, hr, i, iframe, img, li, ol, p, pre, s, strong, u, ul, video
 */
function markdownToNodes(markdown: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const lines = markdown.split('\n');
  let inCodeBlock = false;
  let codeBlockContent = '';
  let inList: 'ul' | 'ol' | null = null;
  let listItems: TelegraphNode[] = [];

  const flushList = () => {
    if (inList && listItems.length > 0) {
      nodes.push({ tag: inList, children: listItems });
      listItems = [];
      inList = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block handling
    if (line.startsWith('```')) {
      flushList();
      if (inCodeBlock) {
        // End code block
        nodes.push({
          tag: 'pre',
          children: [{ tag: 'code', children: [codeBlockContent.trimEnd()] }]
        });
        inCodeBlock = false;
        codeBlockContent = '';
      } else {
        // Start code block
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += line + '\n';
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      flushList();
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushList();
      nodes.push({ tag: 'hr' });
      continue;
    }

    // Headers
    if (line.startsWith('#### ')) {
      flushList();
      nodes.push({ tag: 'h4', children: parseInline(line.slice(5)) });
      continue;
    }
    if (line.startsWith('### ')) {
      flushList();
      nodes.push({ tag: 'h4', children: parseInline(line.slice(4)) });
      continue;
    }
    if (line.startsWith('## ')) {
      flushList();
      nodes.push({ tag: 'h3', children: parseInline(line.slice(3)) });
      continue;
    }
    if (line.startsWith('# ')) {
      flushList();
      nodes.push({ tag: 'h3', children: parseInline(line.slice(2)) });
      continue;
    }

    // Unordered list items
    if (line.match(/^[\s]*[-*+]\s+/)) {
      if (inList !== 'ul') {
        flushList();
        inList = 'ul';
      }
      const content = line.replace(/^[\s]*[-*+]\s+/, '');
      listItems.push({ tag: 'li', children: parseInline(content) });
      continue;
    }

    // Ordered list items
    const orderedMatch = line.match(/^[\s]*(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      if (inList !== 'ol') {
        flushList();
        inList = 'ol';
      }
      listItems.push({ tag: 'li', children: parseInline(orderedMatch[2]) });
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList();
      nodes.push({ tag: 'blockquote', children: parseInline(line.slice(2)) });
      continue;
    }

    // Table handling - convert to clean formatted lists instead of fake tables
    if (line.includes('|') && line.trim().startsWith('|')) {
      flushList();
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());

      // Skip separator rows (e.g., |---|---|)
      if (cells.length > 0 && cells.every(c => /^[-:]+$/.test(c))) {
        continue;
      }

      // Detect header row: if next line is a separator, this is the header
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      const nextCells = nextLine.split('|').filter(c => c.trim()).map(c => c.trim());
      const isHeader = nextCells.length > 0 && nextCells.every(c => /^[-:]+$/.test(c));

      if (isHeader && cells.length > 0) {
        // Store headers for subsequent data rows
        (markdownToNodes as any).__tableHeaders = cells;
        // Render header as a bold line
        nodes.push({ tag: 'p', children: [{ tag: 'b', children: [cells.join('  ·  ')] }] });
        continue;
      }

      // Data row - use stored headers for labeled output
      const headers: string[] = (markdownToNodes as any).__tableHeaders;
      if (headers && headers.length > 0 && cells.length > 0) {
        const parts: TelegraphNode[] = [];
        cells.forEach((cell, idx) => {
          if (idx > 0) parts.push('  |  ');
          if (headers[idx]) {
            parts.push({ tag: 'b', children: [headers[idx] + ': '] });
          }
          parts.push(cell);
        });
        nodes.push({ tag: 'p', children: parts });
      } else if (cells.length > 0) {
        // No headers available - just join with separator
        nodes.push({ tag: 'p', children: [cells.join('  |  ')] });
      }
      continue;
    }

    // Regular paragraph
    flushList();
    nodes.push({ tag: 'p', children: parseInline(line) });
  }

  // Flush any remaining list
  flushList();

  // Close any unclosed code block
  if (inCodeBlock && codeBlockContent) {
    nodes.push({
      tag: 'pre',
      children: [{ tag: 'code', children: [codeBlockContent.trimEnd()] }]
    });
  }

  return nodes;
}

/**
 * Parse inline markdown (bold, italic, code, links, strikethrough)
 * Returns array of Telegraph nodes
 */
function parseInline(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  let remaining = text;

  // Regex patterns for inline elements (order matters - longer patterns first)
  const patterns: Array<{
    regex: RegExp;
    handler: (match: RegExpMatchArray) => TelegraphNode;
  }> = [
    // Links: [text](url)
    {
      regex: /\[([^\]]+)\]\(([^)]+)\)/,
      handler: (m) => ({ tag: 'a', attrs: { href: m[2] }, children: [m[1]] })
    },
    // Bold + Italic: ***text*** or ___text___
    {
      regex: /\*\*\*(.+?)\*\*\*/,
      handler: (m) => ({ tag: 'b', children: [{ tag: 'i', children: [m[1]] }] })
    },
    // Bold: **text** or __text__
    {
      regex: /\*\*(.+?)\*\*/,
      handler: (m) => ({ tag: 'b', children: [m[1]] })
    },
    {
      regex: /__(.+?)__/,
      handler: (m) => ({ tag: 'b', children: [m[1]] })
    },
    // Italic: *text* or _text_ (but not inside words for _)
    {
      regex: /\*(.+?)\*/,
      handler: (m) => ({ tag: 'i', children: [m[1]] })
    },
    {
      regex: /(?<!\w)_(.+?)_(?!\w)/,
      handler: (m) => ({ tag: 'i', children: [m[1]] })
    },
    // Strikethrough: ~~text~~
    {
      regex: /~~(.+?)~~/,
      handler: (m) => ({ tag: 's', children: [m[1]] })
    },
    // Inline code: `code`
    {
      regex: /`([^`]+)`/,
      handler: (m) => ({ tag: 'code', children: [m[1]] })
    },
  ];

  while (remaining.length > 0) {
    let earliestMatch: { index: number; length: number; node: TelegraphNode } | null = null;

    // Find the earliest matching pattern
    for (const pattern of patterns) {
      const match = remaining.match(pattern.regex);
      if (match && match.index !== undefined) {
        if (!earliestMatch || match.index < earliestMatch.index) {
          earliestMatch = {
            index: match.index,
            length: match[0].length,
            node: pattern.handler(match)
          };
        }
      }
    }

    if (earliestMatch) {
      // Add text before the match
      if (earliestMatch.index > 0) {
        nodes.push(remaining.slice(0, earliestMatch.index));
      }
      // Add the matched node
      nodes.push(earliestMatch.node);
      // Continue with the rest
      remaining = remaining.slice(earliestMatch.index + earliestMatch.length);
    } else {
      // No more matches - add remaining text
      nodes.push(remaining);
      break;
    }
  }

  return nodes;
}

/**
 * Create a Telegraph page from markdown content
 */
export async function createTelegraphPage(
  title: string,
  markdown: string
): Promise<string | null> {
  if (!telegraphClient || !telegraphAccount) {
    await initTelegraph();
  }

  if (!telegraphClient) {
    console.error('[Telegraph] Client not initialized');
    return null;
  }

  try {
    const content = markdownToNodes(markdown);

    const page = await telegraphClient.createPage(
      title,
      content,
      'Claude Agent',  // authorName
      undefined,       // authorUrl
      false            // returnContent
    );

    return page.url;
  } catch (error) {
    console.error('[Telegraph] Failed to create page:', error);
    return null;
  }
}

/**
 * Create Telegraph page from an existing markdown file
 */
export async function createTelegraphFromFile(filePath: string): Promise<string | null> {
  try {
    if (!fs.existsSync(filePath)) {
      console.error('[Telegraph] File not found:', filePath);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath, path.extname(filePath));
    const title = fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    return await createTelegraphPage(title, content);
  } catch (error) {
    console.error('[Telegraph] Failed to create page from file:', error);
    return null;
  }
}

// Initialize on module load
initTelegraph().catch(console.error);
