import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { sessionManager } from './session-manager.js';

interface AgentResponse {
  text: string;
  toolsUsed: string[];
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const conversationHistory: Map<number, ConversationMessage[]> = new Map();

const SYSTEM_PROMPT = `You are Claude, an AI assistant helping via Telegram.

Guidelines:
- Be concise - responses appear on a phone screen
- When asked to do tasks, do them directly without asking for confirmation
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly`;

export async function sendToAgent(
  chatId: number,
  message: string,
  onProgress?: (text: string) => void
): Promise<AgentResponse> {
  const session = sessionManager.getSession(chatId);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  sessionManager.updateActivity(chatId);

  // Get or initialize conversation history
  let history = conversationHistory.get(chatId) || [];

  // Add user message to history
  history.push({
    role: 'user',
    content: message,
  });

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;

  try {
    const abortController = new AbortController();

    const response = await query({
      prompt: message,
      options: {
        cwd: session.workingDirectory,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
        permissionMode: 'acceptEdits',
        abortController,
        pathToClaudeCodeExecutable: '/Users/nacho/.local/bin/claude',
        stderr: (data: string) => {
          console.error('[Claude stderr]:', data);
        },
      },
    });

    // Process response messages
    for await (const responseMessage of response) {
      console.log('[Claude] Message type:', responseMessage.type);

      if (responseMessage.type === 'assistant') {
        console.log('[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          console.log('[Claude] Block type:', block.type);
          if (block.type === 'text') {
            fullText += block.text;
            onProgress?.(fullText);
          } else if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
          }
        }
      } else if (responseMessage.type === 'result') {
        console.log('[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;
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
  if (fullText) {
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

export function clearConversation(chatId: number): void {
  conversationHistory.delete(chatId);
}
