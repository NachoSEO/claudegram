import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKCompactBoundaryMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
  type PermissionMode,
  type SettingSource,
  type HookEvent,
  type HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { sessionManager } from './session-manager.js';
import { config } from '../config.js';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  contextWindow: number;
  numTurns: number;
  model: string;
}

interface AgentResponse {
  text: string;
  toolsUsed: string[];
  usage?: AgentUsage;
  compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
  sessionInit?: { model: string; sessionId: string };
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentOptions {
  onProgress?: (text: string) => void;
  onToolStart?: (toolName: string, input?: Record<string, unknown>) => void;
  onToolEnd?: () => void;
  abortController?: AbortController;
  command?: string;
  model?: string;
}

interface LoopOptions extends AgentOptions {
  maxIterations?: number;
  onIterationComplete?: (iteration: number, response: string) => void;
}

const conversationHistory: Map<number, ConversationMessage[]> = new Map();

// Track Claude Code session IDs per chat for conversation continuity
const chatSessionIds: Map<number, string> = new Map();

// Track current model per chat (default: opus)
const chatModels: Map<number, string> = new Map();

// Cache latest usage per chat for /context and /status commands
const chatUsageCache: Map<number, AgentUsage> = new Map();

export function getCachedUsage(chatId: number): AgentUsage | undefined {
  return chatUsageCache.get(chatId);
}

const BASE_SYSTEM_PROMPT = `You are ${config.BOT_NAME}, an AI assistant helping via Telegram.

Guidelines:
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly

Response Formatting — Telegraph-Aware Writing:
Your responses are displayed via Telegram. Short responses render inline as MarkdownV2.
Longer responses (2500+ chars) are published as Telegraph (telegra.ph) Instant View pages.
You MUST write with Telegraph's rendering constraints in mind at all times.

Telegraph supports ONLY these elements:
- Headings: h3 (from # and ##) and h4 (from ### and ####). No h1, h2, h5, h6.
- Text formatting: **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item). Nested lists are supported (indent sub-items).
- Code blocks: \`\`\`code\`\`\` — rendered as monospace preformatted text. No syntax highlighting.
- Blockquotes: > text
- Horizontal rules: ---

Telegraph does NOT support:
- TABLES — pipe-delimited markdown tables (|col|col|) will NOT render as tables. They break into ugly labeled text. NEVER use markdown tables.
- No checkboxes, footnotes, or task lists
- No custom colors, fonts, or inline styles
- Only two heading levels (h3, h4)

Instead of tables, use these alternatives (in order of preference):
1. Bullet lists with bold labels — best for key-value data or comparisons:
   - **Name**: Alice
   - **Age**: 30
   - **City**: NYC

2. Nested lists — best for grouped/categorized data:
   - **Frontend**
     - React 18
     - TypeScript
   - **Backend**
     - Node.js
     - Express

3. Bold headers with list items — best for feature/comparison matrices:
   **Telegram bot** — Grammy v1.31
   **AI agent** — Claude Code SDK v1.0
   **TTS** — OpenAI gpt-4o-mini-tts

4. Preformatted code blocks — ONLY for data where alignment matters (ASCII tables):
   \`\`\`
   Name      Age   City
   Alice     30    NYC
   Bob       25    London
   \`\`\`
   Note: code blocks lose all formatting (no bold, links, etc.) so only use when alignment is critical.

Structure guidelines for long responses:
- Use ## or ### headings to create clear sections (renders as h3/h4)
- Use --- horizontal rules to separate major sections
- Use bullet lists liberally — they render cleanly
- Use > blockquotes for callouts, warnings, or important notes
- Keep paragraphs concise; Telegraph renders best with short blocks of text
- Nest sub-items under list items for tree-like structures instead of indented text`;

const REDDIT_TOOL_PROMPT = `

Reddit Tool:
You have access to a Reddit fetching tool via Bash.
Path: python3 ${config.REDDITFETCH_PATH} <target> [options]

Targets: post URL, post ID, r/<subreddit>, u/<username>, share links (reddit.com/r/.../s/...)
Flags: --sort <hot|new|top|rising>, --limit <n>, --time <day|week|month|year|all>, --depth <n>, -o <file>, -f <markdown|json>
The tool handles its own authentication. Always use the full absolute path shown above.

IMPORTANT — File-Based Workflow for Single Posts:
When fetching a single Reddit post (URL or ID), ALWAYS use this workflow to avoid flooding your context with thousands of comments:

1. Save to file:
   mkdir -p .reddit && python3 ${config.REDDITFETCH_PATH} "<url>" --depth 5 -o .reddit/<post_id>.md
   Extract the post ID from the URL for the filename (e.g., 1lmkfhf.md). If it's a share link, use a slug from the URL.

2. Read overview (first ~100 lines for post header + top comments):
   Use the Read tool on .reddit/<post_id>.md with limit=200

3. Report the overview to the user. Note the total comment count.

4. When the user asks about a specific comment or user:
   - Use Grep on .reddit/<post_id>.md to find by username (e.g., pattern "u/username") or keyword
   - Use Read with offset/limit around the match to get full context
   - Quote the relevant comment directly in your response

5. Do NOT re-fetch unless the user explicitly asks. Reuse the saved .reddit/ file for all follow-up questions about the same post.

For subreddit feeds (r/<sub>) and user profiles (u/<user>), output directly to stdout — no file needed since these are short listings.

Semantic mappings for natural language Reddit queries:
- "today" / "today's top" → --sort top --time day
- "newest" / "latest" / "recent" → --sort new
- "hottest" / "trending" / "what's hot" → --sort hot
- "top" / "best" → --sort top
- "this week" → --sort top --time week
- "this month" → --sort top --time month
- "rising" → --sort rising`;

const REDDIT_VIDEO_TOOL_PROMPT = `

Reddit Video Tool:
The user can download Reddit-hosted videos via the /vreddit Telegram command.
If the user wants a video file, tell them to use /vreddit with the post URL.
Do NOT use the Reddit Tool above to download media; it is for text/comments only.`;

const MEDIUM_TOOL_PROMPT = `

Medium Tool:
The user can fetch Medium articles via the /medium Telegram command (uses Freedium).
You do NOT need to fetch Medium articles yourself — the bot handles it directly.`;

const EXTRACT_TOOL_PROMPT = `

Media Extract Tool:
The user can extract text transcripts, audio, or video from YouTube, Instagram, and TikTok URLs using the /extract Telegram command.
Usage: /extract <url> — shows a menu to pick: Text, Audio, Video, or All.
- Text: Downloads audio, transcribes via Groq Whisper, returns transcript
- Audio: Downloads and sends the audio file (MP3)
- Video: Downloads and sends the video file (MP4, if under 50MB)
- All: Returns transcript + audio + video
If the user asks you to transcribe a YouTube/Instagram/TikTok video, tell them to use /extract with the URL.
For voice notes sent directly in chat, use /transcribe instead.`;

const REASONING_SUMMARY_INSTRUCTIONS = `

Reasoning Summary (required when enabled):
- At the end of each response, add a short section titled "Reasoning Summary".
- Provide 2–5 bullet points describing high-level actions/decisions taken.
- Do NOT reveal chain-of-thought, hidden reasoning, or sensitive tool outputs.
- Skip the summary for very short acknowledgements or pure error messages.`;

const TOOL_PROMPTS = [
  config.REDDIT_ENABLED ? REDDIT_TOOL_PROMPT : '',
  config.VREDDIT_ENABLED ? REDDIT_VIDEO_TOOL_PROMPT : '',
  config.MEDIUM_ENABLED ? MEDIUM_TOOL_PROMPT : '',
  config.EXTRACT_ENABLED ? EXTRACT_TOOL_PROMPT : '',
].join('');

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}${TOOL_PROMPTS}${config.CLAUDE_REASONING_SUMMARY ? REASONING_SUMMARY_INSTRUCTIONS : ''}`;

/**
 * Strip the "Reasoning Summary" section from the end of a response
 * so it doesn't appear in Telegram chat (it's already in logs).
 */
function stripReasoningSummary(text: string): string {
  // Match a trailing reasoning summary block:
  //   ---\n**Reasoning Summary**\n... (to end)
  //   or: **Reasoning Summary**\n... (to end)
  //   or: *Reasoning Summary*\n... (to end)
  return text.replace(/\n*(?:---\n+)?(?:\*{1,2})Reasoning Summary(?:\*{1,2})\n[\s\S]*$/, '').trimEnd();
}

type LogLevel = 'off' | 'basic' | 'verbose' | 'trace';
const LOG_LEVELS: Record<LogLevel, number> = {
  off: 0,
  basic: 1,
  verbose: 2,
  trace: 3,
};

function getLogLevel(): LogLevel {
  return config.CLAUDE_SDK_LOG_LEVEL as LogLevel;
}

function logAt(level: LogLevel, message: string, data?: unknown): void {
  if (LOG_LEVELS[level] <= LOG_LEVELS[getLogLevel()]) {
    if (data !== undefined) {
      console.log(message, data);
    } else {
      console.log(message);
    }
  }
}

function getPermissionMode(command?: string): PermissionMode {
  // If DANGEROUS_MODE is enabled, bypass all permissions
  if (config.DANGEROUS_MODE) {
    return 'bypassPermissions';
  }

  // Otherwise, use command-specific modes
  if (command === 'plan') {
    return 'plan';
  }

  return 'acceptEdits';
}

export async function sendToAgent(
  chatId: number,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, onToolStart, onToolEnd, abortController, command, model } = options;

  const session = sessionManager.getSession(chatId);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  sessionManager.updateActivity(chatId, message);

  // Get or initialize conversation history
  let history = conversationHistory.get(chatId) || [];

  // Determine the prompt based on command
  let prompt = message;
  if (command === 'explore') {
    prompt = `Explore the codebase and answer: ${message}`;
  }

  // Add user message to history
  history.push({
    role: 'user',
    content: prompt,
  });

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;
  let resultUsage: AgentUsage | undefined;
  let compactionEvent: { trigger: 'manual' | 'auto'; preTokens: number } | undefined;
  let initEvent: { model: string; sessionId: string } | undefined;

  // Determine permission mode
  const permissionMode = getPermissionMode(command);

  // Determine model to use
  const effectiveModel = model || chatModels.get(chatId) || undefined;

  try {
    const controller = abortController || new AbortController();

    const existingSessionId = chatSessionIds.get(chatId) || session.claudeSessionId;

    // Log session resume if applicable
    if (existingSessionId) {
      if (!chatSessionIds.get(chatId)) {
        chatSessionIds.set(chatId, existingSessionId);
      }
      logAt('basic', `[Claude] Resuming session ${existingSessionId} for chat ${chatId}`);
    }

    const toolsOption = config.DANGEROUS_MODE
      ? { type: 'preset' as const, preset: 'claude_code' as const }
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

    const allowedToolsOption = config.DANGEROUS_MODE
      ? undefined
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

    // PreCompact hook always registered (logging only — notification sent from compact_boundary message)
    const preCompactHook: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreCompact: [{
        hooks: [async (input) => {
          logAt('basic', '[Hook] PreCompact — context is about to be compacted', {
            trigger: (input as Record<string, unknown>).trigger,
            customInstructions: (input as Record<string, unknown>).custom_instructions,
          });
          return { continue: true };
        }],
      }],
    };

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined =
      LOG_LEVELS[getLogLevel()] >= LOG_LEVELS.verbose
        ? {
          ...preCompactHook,
          PreToolUse: [{
            hooks: [async (input) => {
              logAt('verbose', '[Hook] PreToolUse', input);
              return { continue: true };
            }],
          }],
          PostToolUse: [{
            hooks: [async (input) => {
              logAt('verbose', '[Hook] PostToolUse', input);
              return { continue: true };
            }],
          }],
          PostToolUseFailure: [{
            hooks: [async (input) => {
              logAt('verbose', '[Hook] PostToolUseFailure', input);
              return { continue: true };
            }],
          }],
          PermissionRequest: [{
            hooks: [async (input) => {
              logAt('verbose', '[Hook] PermissionRequest', input);
              return { continue: true };
            }],
          }],
          SessionStart: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionStart', input);
              return { continue: true };
            }],
          }],
          SessionEnd: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionEnd', input);
              return { continue: true };
            }],
          }],
          Notification: [{
            hooks: [async (input) => {
              logAt('verbose', '[Hook] Notification', input);
              return { continue: true };
            }],
          }],
        }
        : preCompactHook;

    // Validate cwd exists — stale sessions may reference paths from another OS
    let cwd = session.workingDirectory;
    try {
      if (!fs.existsSync(cwd)) {
        const fallback = process.env.HOME || process.cwd();
        console.warn(`[Claude] Working directory does not exist: ${cwd}, falling back to ${fallback}`);
        cwd = fallback;
      }
    } catch {
      cwd = process.env.HOME || process.cwd();
    }

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd,
      tools: toolsOption,
      ...(allowedToolsOption ? { allowedTools: allowedToolsOption } : {}),
      permissionMode,
      abortController: controller,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: SYSTEM_PROMPT,
      },
      settingSources: ['project', 'user'] as SettingSource[],
      model: effectiveModel,
      resume: existingSessionId,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(config.CLAUDE_USE_BUNDLED_EXECUTABLE ? {} : { pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH }),
      includePartialMessages: config.CLAUDE_SDK_INCLUDE_PARTIAL || getLogLevel() === 'trace',
      hooks,
      stderr: (data: string) => {
        console.error('[Claude stderr]:', data);
      },
    };

    const response = await query({
      prompt,
      options: queryOptions,
    });

    // Process response messages
    for await (const responseMessage of response) {
      // Check for abort
      if (controller.signal.aborted) {
        fullText = '🛑 Request cancelled.';
        break;
      }

      logAt('trace', '[Claude] Message type:', responseMessage.type);

      if (responseMessage.type === 'assistant') {
        logAt('verbose', '[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          logAt('trace', '[Claude] Block type:', block.type);
          if (block.type === 'text') {
            fullText += block.text;
            onProgress?.(fullText);
          } else if (block.type === 'tool_use') {
            const toolInput = 'input' in block ? block.input as Record<string, unknown> : {};
            const inputSummary = toolInput.command
              ? String(toolInput.command).substring(0, 150)
              : toolInput.pattern
                ? String(toolInput.pattern)
                : toolInput.file_path
                  ? String(toolInput.file_path)
                  : '';
            logAt('verbose', `[Claude] Tool: ${block.name}${inputSummary ? ` → ${inputSummary}` : ''}`);
            toolsUsed.push(block.name);
            // Notify tool start for terminal UI
            onToolStart?.(block.name, toolInput);
          }
        }
      } else if (responseMessage.type === 'system') {
        if (responseMessage.subtype === 'compact_boundary') {
          const cbMsg = responseMessage as SDKCompactBoundaryMessage;
          compactionEvent = {
            trigger: cbMsg.compact_metadata.trigger,
            preTokens: cbMsg.compact_metadata.pre_tokens,
          };
          logAt('basic', `[Claude] COMPACTION: trigger=${cbMsg.compact_metadata.trigger}, pre_tokens=${cbMsg.compact_metadata.pre_tokens}`);
        } else if (responseMessage.subtype === 'init') {
          const sysMsg = responseMessage as SDKSystemMessage;
          initEvent = {
            model: sysMsg.model,
            sessionId: sysMsg.session_id,
          };
          logAt('basic', `[Claude] SESSION INIT: model=${sysMsg.model}, session=${sysMsg.session_id}`);
        } else if (responseMessage.subtype === 'status') {
          const statusMsg = responseMessage as SDKStatusMessage;
          if (statusMsg.status === 'compacting') {
            logAt('basic', '[Claude] STATUS: compacting in progress');
          }
        } else {
          logAt('verbose', `[Claude] System: ${responseMessage.subtype ?? 'unknown'}`, responseMessage);
        }
      } else if (responseMessage.type === 'tool_progress') {
        logAt('verbose', `[Claude] Tool progress: ${responseMessage.tool_name}`, responseMessage);
      } else if (responseMessage.type === 'tool_use_summary') {
        logAt('verbose', '[Claude] Tool use summary', responseMessage);
        // Notify tool end for terminal UI (summary doesn't include tool name)
        onToolEnd?.();
      } else if (responseMessage.type === 'auth_status') {
        logAt('basic', '[Claude] Auth status', responseMessage);
      } else if (responseMessage.type === 'stream_event') {
        logAt('trace', '[Claude] Stream event', responseMessage.event);
      } else if (responseMessage.type === 'result') {
        logAt('basic', '[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;

        // Capture session_id for conversation continuity
        if ('session_id' in responseMessage && responseMessage.session_id) {
          chatSessionIds.set(chatId, responseMessage.session_id);
          sessionManager.setClaudeSessionId(chatId, responseMessage.session_id);
          logAt('basic', `[Claude] Stored session ${responseMessage.session_id} for chat ${chatId}`);
        }

        // Extract usage data from result
        const resultMsg = responseMessage as SDKResultMessage;
        if (resultMsg.modelUsage) {
          const modelKey = Object.keys(resultMsg.modelUsage)[0];
          if (modelKey && resultMsg.modelUsage[modelKey]) {
            const mu = resultMsg.modelUsage[modelKey];
            resultUsage = {
              inputTokens: mu.inputTokens,
              outputTokens: mu.outputTokens,
              cacheReadTokens: mu.cacheReadInputTokens,
              cacheWriteTokens: mu.cacheCreationInputTokens,
              totalCostUsd: resultMsg.total_cost_usd,
              contextWindow: mu.contextWindow,
              numTurns: resultMsg.num_turns,
              model: modelKey,
            };
          }
        }

        if (responseMessage.subtype === 'success') {
          // Append final result text if different from accumulated
          if (responseMessage.result && !fullText.includes(responseMessage.result)) {
            if (fullText.length > 0) {
              fullText += '\n\n';
            }
            fullText += responseMessage.result;
            onProgress?.(fullText);
          }
        } else {
          // error_max_turns or error_during_execution
          fullText = `Error: ${responseMessage.subtype}`;
          onProgress?.(fullText);
        }
      }
    }
  } catch (error) {
    // If aborted, return cancellation message
    if (abortController?.signal.aborted) {
      return {
        text: '🛑 Request cancelled.',
        toolsUsed,
      };
    }

    // If we got a result, ignore process exit errors (SDK quirk)
    if (gotResult && error instanceof Error && error.message.includes('exited with code')) {
      console.log('[Claude] Ignoring exit code error after successful result');
    } else {
      console.error('[Claude] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Claude error: ${errorMessage}`);
    }
  }

  // Add assistant response to history
  if (fullText && !abortController?.signal.aborted) {
    history.push({
      role: 'assistant',
      content: fullText,
    });
  }

  conversationHistory.set(chatId, history);

  // Cache usage for /context and /status commands
  if (resultUsage) {
    chatUsageCache.set(chatId, resultUsage);
  }

  return {
    text: stripReasoningSummary(fullText) || 'No response from Claude.',
    toolsUsed,
    usage: resultUsage,
    compaction: compactionEvent,
    sessionInit: initEvent,
  };
}

export async function sendLoopToAgent(
  chatId: number,
  message: string,
  options: LoopOptions = {}
): Promise<AgentResponse> {
  const {
    onProgress,
    abortController,
    maxIterations = config.MAX_LOOP_ITERATIONS,
    onIterationComplete,
  } = options;

  const session = sessionManager.getSession(chatId);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  // Wrap the prompt with loop instructions
  const loopPrompt = `${message}

IMPORTANT: When you have fully completed this task, respond with the word "DONE" on its own line at the end of your response. If you need to continue working, do not say "DONE".`;

  let iteration = 0;
  let combinedText = '';
  const allToolsUsed: string[] = [];
  let isComplete = false;

  while (iteration < maxIterations && !isComplete) {
    iteration++;

    // Check for abort
    if (abortController?.signal.aborted) {
      return {
        text: '🛑 Loop cancelled.',
        toolsUsed: allToolsUsed,
      };
    }

    const iterationPrefix = `\n\n--- Iteration ${iteration}/${maxIterations} ---\n\n`;
    combinedText += iterationPrefix;
    onProgress?.(combinedText);

    // For subsequent iterations, prompt Claude to continue
    const currentPrompt = iteration === 1 ? loopPrompt : 'Continue the task. Say "DONE" when complete.';

    try {
      const response = await sendToAgent(chatId, currentPrompt, {
        onProgress: (text) => {
          onProgress?.(combinedText + text);
        },
        abortController,
        model: options.model,
      });

      combinedText += response.text;
      allToolsUsed.push(...response.toolsUsed);

      onIterationComplete?.(iteration, response.text);

      // Check if Claude said DONE
      if (response.text.includes('DONE')) {
        isComplete = true;
        combinedText += '\n\n✅ Loop completed.';
      } else if (iteration >= maxIterations) {
        combinedText += `\n\n⚠️ Max iterations (${maxIterations}) reached.`;
      }

      onProgress?.(combinedText);
    } catch (error) {
      if (abortController?.signal.aborted) {
        return {
          text: combinedText + '\n\n🛑 Loop cancelled.',
          toolsUsed: allToolsUsed,
        };
      }
      throw error;
    }
  }

  return {
    text: stripReasoningSummary(combinedText),
    toolsUsed: allToolsUsed,
  };
}

export function clearConversation(chatId: number): void {
  conversationHistory.delete(chatId);
  chatSessionIds.delete(chatId);
  chatUsageCache.delete(chatId);
}

export function setModel(chatId: number, model: string): void {
  chatModels.set(chatId, model);
}

export function getModel(chatId: number): string {
  return chatModels.get(chatId) || 'opus';
}

export function clearModel(chatId: number): void {
  chatModels.delete(chatId);
}

export function isDangerousMode(): boolean {
  return config.DANGEROUS_MODE;
}
