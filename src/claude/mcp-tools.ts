/**
 * MCP Tools — In-process MCP server factory for Claudegram.
 *
 * Wraps existing standalone functions (reddit, medium, extract, telegraph,
 * project management) as MCP tools so Claude can invoke them automatically
 * based on conversation context instead of requiring explicit /commands.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { InputFile, type Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../utils/workspace-guard.js';

// Lazy imports to avoid circular deps and unnecessary module loading
async function importReddit() {
  return import('../reddit/redditfetch.js');
}

async function importMedium() {
  return import('../medium/freedium.js');
}

async function importExtract() {
  return import('../media/extract.js');
}

async function importTelegraph() {
  return import('../telegram/telegraph.js');
}

// ── Types ────────────────────────────────────────────────────────────

export interface McpToolsContext {
  telegramCtx: Context;
  sessionKey: string;
}

// ── Constants ────────────────────────────────────────────────────────

const REDDIT_MAX_CHARS = 50_000;

// ── Factory ──────────────────────────────────────────────────────────

export function createClaudegramMcpServer(
  toolsCtx: McpToolsContext
): McpSdkServerConfigWithInstance {
  const tools = buildToolList(toolsCtx);

  return createSdkMcpServer({
    name: 'claudegram-tools',
    version: '1.0.0',
    tools,
  });
}

function buildToolList(toolsCtx: McpToolsContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    listProjectsTool(toolsCtx),
    switchProjectTool(toolsCtx),
  ];

  if (config.REDDIT_ENABLED) {
    tools.push(fetchRedditTool(toolsCtx));
  }

  if (config.MEDIUM_ENABLED) {
    tools.push(fetchMediumTool(toolsCtx));
  }

  if (config.EXTRACT_ENABLED) {
    tools.push(extractMediaTool(toolsCtx));
  }

  if (config.TELEGRAPH_ENABLED) {
    tools.push(publishTelegraphTool(toolsCtx));
  }

  return tools;
}

// ── Tool Definitions ─────────────────────────────────────────────────

function listProjectsTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_list_projects',
    'List all available projects in the workspace directory. Use this to see what projects the user can switch to.',
    {},
    async () => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        const projects = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);

        return {
          content: [{
            type: 'text' as const,
            text: `Projects in ${workspaceRoot}:\n${projects.join('\n')}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function switchProjectTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_switch_project',
    'Switch the working directory to a different project. The change takes effect on the next query. Use claudegram_list_projects first to see available projects.',
    { project_name: z.string().describe('Name of the project directory to switch to') },
    async ({ project_name }) => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const targetPath = path.resolve(workspaceRoot, project_name);

        if (!isPathWithinRoot(workspaceRoot, targetPath)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Path must be within workspace root: ${workspaceRoot}` }],
            isError: true,
          };
        }

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Project not found: ${project_name}` }],
            isError: true,
          };
        }

        sessionManager.setWorkingDirectory(toolsCtx.sessionKey, targetPath);

        return {
          content: [{
            type: 'text' as const,
            text: `Switched to project: ${project_name} (${targetPath}). The new working directory will take effect on the next query.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error switching project: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function fetchRedditTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_fetch_reddit',
    'Fetch Reddit content: subreddit listings, post threads with comments, or user profiles. Supports sort/time filters for subreddits. Returns markdown-formatted results.',
    {
      target: z.string().describe('Reddit target: r/<subreddit>, u/<username>, post URL, post ID, or share link'),
      sort: z.enum(['hot', 'new', 'top', 'rising']).optional().describe('Sort order (default: hot). Semantic mappings: "trending"→hot, "latest"→new, "best"→top'),
      limit: z.number().optional().describe('Number of posts to fetch (default: 10)'),
      time_filter: z.enum(['day', 'week', 'month', 'year', 'all']).optional().describe('Time filter for top sort. Semantic: "today"→day, "this week"→week'),
      depth: z.number().optional().describe('Comment depth for post threads (default: 5)'),
    },
    async ({ target, sort, limit, time_filter, depth }) => {
      try {
        const { redditFetch } = await importReddit();
        const result = await redditFetch([target], {
          format: 'markdown',
          sort: sort || 'hot',
          limit: limit || config.REDDITFETCH_DEFAULT_LIMIT,
          depth: depth || config.REDDITFETCH_DEFAULT_DEPTH,
          timeFilter: time_filter,
        });

        const truncated = result.length > REDDIT_MAX_CHARS
          ? result.substring(0, REDDIT_MAX_CHARS) + '\n\n[... truncated — content exceeded 50k chars]'
          : result;

        return {
          content: [{ type: 'text' as const, text: truncated }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Reddit fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function fetchMediumTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_fetch_medium',
    'Fetch a Medium article via Freedium (bypasses paywall). Returns the article title, author, and full markdown content.',
    {
      url: z.string().describe('Medium article URL (medium.com, towardsdatascience.com, etc.)'),
    },
    async ({ url }) => {
      try {
        const { fetchMediumArticle, isMediumUrl } = await importMedium();

        if (!isMediumUrl(url)) {
          return {
            content: [{ type: 'text' as const, text: 'Error: URL does not appear to be a Medium article.' }],
            isError: true,
          };
        }

        const article = await fetchMediumArticle(url);

        return {
          content: [{
            type: 'text' as const,
            text: `# ${article.title}\n**By ${article.author}**\n\n${article.markdown}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Medium fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function extractMediaTool(toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_extract_media',
    'Extract text transcripts, audio, or video from YouTube, Instagram, and TikTok URLs. Audio/video files are sent directly to the user via Telegram. Transcripts are returned as text.',
    {
      url: z.string().describe('URL of the video (YouTube, Instagram, or TikTok)'),
      mode: z.enum(['text', 'audio', 'video', 'all']).describe('What to extract: "text" for transcript, "audio" for MP3, "video" for MP4, "all" for everything'),
    },
    async ({ url, mode }) => {
      const { extractMedia, cleanupExtractResult } = await importExtract();
      let result: Awaited<ReturnType<typeof extractMedia>> | undefined;

      try {
        result = await extractMedia({ url, mode });

        const ctx = toolsCtx.telegramCtx;
        const parts: string[] = [];

        // Send media files to user via Telegram
        if (result.videoPath) {
          try {
            await ctx.replyWithVideo(new InputFile(result.videoPath), {
              caption: `📹 ${result.title}`,
            });
            parts.push('Video sent to user.');
          } catch (err) {
            parts.push(`Video send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.audioPath && (mode === 'audio' || mode === 'all')) {
          try {
            await ctx.replyWithAudio(new InputFile(result.audioPath), {
              caption: `🎵 ${result.title}`,
            });
            parts.push('Audio sent to user.');
          } catch (err) {
            parts.push(`Audio send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.transcript) {
          parts.push(`Transcript:\n\n${result.transcript}`);
        }

        if (result.warnings.length > 0) {
          parts.push(`Warnings: ${result.warnings.join('; ')}`);
        }

        if (parts.length === 0) {
          parts.push('Extraction completed but no content was produced.');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Media extraction error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      } finally {
        if (result) {
          cleanupExtractResult(result);
        }
      }
    }
  );
}

function publishTelegraphTool(_toolsCtx: McpToolsContext) {
  return tool(
    'claudegram_publish_telegraph',
    'Publish markdown content as a Telegraph (telegra.ph) Instant View page. Returns the URL. Useful for sharing long-form content as a readable link.',
    {
      title: z.string().describe('Page title'),
      markdown: z.string().describe('Markdown content for the page'),
    },
    async ({ title, markdown }) => {
      try {
        const { createTelegraphPage } = await importTelegraph();
        const url = await createTelegraphPage(title, markdown);

        if (!url) {
          return {
            content: [{ type: 'text' as const, text: 'Failed to create Telegraph page.' }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Telegraph page created: ${url}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Telegraph error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

