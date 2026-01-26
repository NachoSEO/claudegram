import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { sessionManager } from './session-manager.js';
import { config } from '../config.js';

interface AgentResponse {
  text: string;
  toolsUsed: string[];
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentOptions {
  onProgress?: (text: string) => void;
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

// Track current model per chat (default: sonnet)
const chatModels: Map<number, string> = new Map();

const SYSTEM_PROMPT = `You are ${config.BOT_NAME}, an AI assistant helping via Telegram.

Guidelines:
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly

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

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

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
  const { onProgress, abortController, command, model } = options;

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

  // Determine permission mode
  const permissionMode = getPermissionMode(command);

  // Determine model to use
  const effectiveModel = model || chatModels.get(chatId) || undefined;

  try {
    const controller = abortController || new AbortController();

    const existingSessionId = chatSessionIds.get(chatId);

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd: session.workingDirectory,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
      permissionMode,
      abortController: controller,
      pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH,
      appendSystemPrompt: SYSTEM_PROMPT,
      stderr: (data: string) => {
        console.error('[Claude stderr]:', data);
      },
    };

    // Resume existing session for conversation continuity
    if (existingSessionId) {
      queryOptions.resume = existingSessionId;
      console.log(`[Claude] Resuming session ${existingSessionId} for chat ${chatId}`);
    }

    // Add model if specified
    if (effectiveModel) {
      (queryOptions as Record<string, unknown>).model = effectiveModel;
    }

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

      console.log('[Claude] Message type:', responseMessage.type);

      if (responseMessage.type === 'assistant') {
        console.log('[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          console.log('[Claude] Block type:', block.type);
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
            console.log(`[Claude] Tool: ${block.name}${inputSummary ? ` → ${inputSummary}` : ''}`);
            toolsUsed.push(block.name);
          }
        }
      } else if (responseMessage.type === 'result') {
        console.log('[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;

        // Capture session_id for conversation continuity
        if ('session_id' in responseMessage && responseMessage.session_id) {
          chatSessionIds.set(chatId, responseMessage.session_id);
          console.log(`[Claude] Stored session ${responseMessage.session_id} for chat ${chatId}`);
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

  return {
    text: fullText || 'No response from Claude.',
    toolsUsed,
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
    text: combinedText,
    toolsUsed: allToolsUsed,
  };
}

export function clearConversation(chatId: number): void {
  conversationHistory.delete(chatId);
  chatSessionIds.delete(chatId);
}

export function setModel(chatId: number, model: string): void {
  chatModels.set(chatId, model);
}

export function getModel(chatId: number): string {
  return chatModels.get(chatId) || 'sonnet';
}

export function clearModel(chatId: number): void {
  chatModels.delete(chatId);
}

export function isDangerousMode(): boolean {
  return config.DANGEROUS_MODE;
}
