/**
 * Agent facade — delegates to the configured provider (Claude or OpenAI).
 *
 * All 24 consumer files import from this module. Exports are UNCHANGED.
 * The active provider is selected via `AGENT_PROVIDER` env var.
 */

import { getProvider } from '../providers/factory.js';
import { stripReasoningSummary } from '../providers/system-prompt.js';
import { config } from '../config.js';

import type {
  AgentResponse,
  AgentOptions,
  LoopOptions,
  Platform,
  AgentUsage,
  AgentInputItem,
} from '../providers/types.js';

// Re-export types so consumers don't need to change imports
export type { AgentResponse, AgentOptions, LoopOptions, Platform, AgentUsage, AgentInputItem };

export function getCachedUsage(chatId: number): AgentUsage | undefined {
  return getProvider().getCachedUsage(chatId);
}

export async function sendToAgent(
  chatId: number,
  message: string | AgentInputItem[],
  options: AgentOptions = {},
): Promise<AgentResponse> {
  return getProvider().send(chatId, message, options);
}

export async function sendLoopToAgent(
  chatId: number,
  message: string,
  options: LoopOptions = {},
): Promise<AgentResponse> {
  const {
    onProgress,
    abortController,
    maxIterations = config.MAX_LOOP_ITERATIONS,
    onIterationComplete,
  } = options;

  const provider = getProvider();

  // Wrap the prompt with loop instructions
  const loopPrompt = `${message}

IMPORTANT: When you have fully completed this task, respond with the word "DONE" on its own line at the end of your response. If you need to continue working, do not say "DONE".`;

  let iteration = 0;
  let combinedText = '';
  const allToolsUsed: string[] = [];
  let isComplete = false;

  while (iteration < maxIterations && !isComplete) {
    iteration++;

    if (abortController?.signal.aborted) {
      return { text: '🛑 Loop cancelled.', toolsUsed: allToolsUsed };
    }

    const iterationPrefix = `\n\n--- Iteration ${iteration}/${maxIterations} ---\n\n`;
    combinedText += iterationPrefix;
    onProgress?.(combinedText);

    const currentPrompt = iteration === 1 ? loopPrompt : 'Continue the task. Say "DONE" when complete.';

    try {
      const response = await provider.send(chatId, currentPrompt, {
        onProgress: (text) => {
          onProgress?.(combinedText + text);
        },
        abortController,
        model: options.model,
      });

      combinedText += response.text;
      allToolsUsed.push(...response.toolsUsed);

      onIterationComplete?.(iteration, response.text);

      if (response.text.includes('DONE')) {
        isComplete = true;
        combinedText += '\n\n✅ Loop completed.';
      } else if (iteration >= maxIterations) {
        combinedText += `\n\n⚠️ Max iterations (${maxIterations}) reached.`;
      }

      onProgress?.(combinedText);
    } catch (error: unknown) {
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
  // Fire-and-forget: OpenAI provider may return Promise for remote cleanup
  const result = getProvider().clearConversation(chatId);
  if (result instanceof Promise) {
    result.catch((err) => {
      console.error(`[Agent] clearConversation failed for chat ${chatId}:`, err);
    });
  }
}

export function setModel(chatId: number, model: string): void {
  getProvider().setModel(chatId, model);
}

export function getModel(chatId: number): string {
  return getProvider().getModel(chatId);
}

export function clearModel(chatId: number): void {
  getProvider().clearModel(chatId);
}

export function isDangerousMode(): boolean {
  return getProvider().isDangerousMode();
}
