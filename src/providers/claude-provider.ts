/**
 * Claude Agent SDK provider — extracted from agent.ts.
 *
 * All SDK-specific logic lives here. The agent.ts facade delegates to this class.
 */

import * as fs from 'fs';

import {
  query,
  type SDKResultMessage,
  type SDKCompactBoundaryMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
  type PermissionMode,
  type SettingSource,
  type HookEvent,
  type HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';

import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { setActiveQuery, isCancelled } from '../claude/request-queue.js';
import { eventBus } from '../dashboard/event-bus.js';
import { contextMonitor } from '../claude/context-monitor.js';
import { getSystemPrompt, stripReasoningSummary } from './system-prompt.js';

import type {
  AgentProvider,
  AgentUsage,
  AgentResponse,
  AgentOptions,
  AgentInputItem,
  Cancellable,
} from './types.js';

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
  if (config.DANGEROUS_MODE) {
    return 'bypassPermissions';
  }
  if (command === 'plan') {
    return 'plan';
  }
  return 'acceptEdits';
}

/** Wraps the SDK `Query` async iterable into the `Cancellable` interface. */
class QueryCancellable implements Cancellable {
  constructor(private readonly q: ReturnType<typeof query>) {}

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }
}

export class ClaudeProvider implements AgentProvider {
  private readonly conversationHistory = new Map<number, Array<{ role: 'user' | 'assistant'; content: string }>>();
  private readonly chatSessionIds = new Map<number, string>();
  private readonly chatModels = new Map<number, string>();
  private readonly chatUsageCache = new Map<number, AgentUsage>();

  async send(
    chatId: number,
    message: string | AgentInputItem[],
    options: AgentOptions,
  ): Promise<AgentResponse> {
    const { onProgress, onToolStart, onToolEnd, abortController, command, model, platform } = options;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      throw new Error('No active session. Use /project to set working directory.');
    }

    const logMessage = Array.isArray(message) ? '[complex-input]' : message;

    sessionManager.updateActivity(chatId, logMessage);

    const history = this.conversationHistory.get(chatId) || [];

    let prompt = logMessage;
    if (command === 'explore') {
      prompt = `Explore the codebase and answer: ${logMessage}`;
    }

    history.push({ role: 'user', content: prompt });

    let fullText = '';
    const toolsUsed: string[] = [];
    let gotResult = false;
    let resultUsage: AgentUsage | undefined;
    let compactionEvent: { trigger: 'manual' | 'auto'; preTokens: number } | undefined;
    let initEvent: { model: string; sessionId: string } | undefined;
    let agentStartTime = Date.now();

    const permissionMode = getPermissionMode(command);
    const effectiveModel = model || this.chatModels.get(chatId) || 'opus';

    try {
      const controller = abortController || new AbortController();
      const existingSessionId = this.chatSessionIds.get(chatId) || session.claudeSessionId;

      if (existingSessionId) {
        if (!this.chatSessionIds.get(chatId)) {
          this.chatSessionIds.set(chatId, existingSessionId);
        }
        logAt('basic', `[Claude] Resuming session ${existingSessionId} for chat ${chatId}`);
      }

      const toolsOption = config.DANGEROUS_MODE
        ? { type: 'preset' as const, preset: 'claude_code' as const }
        : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

      const allowedToolsOption = config.DANGEROUS_MODE
        ? undefined
        : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

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

      const verboseHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = config.LOG_AGENT_HOOKS
        ? {
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
          Notification: [{
            hooks: [async (input) => {
              logAt('verbose', '[Hook] Notification', input);
              return { continue: true };
            }],
          }],
        }
        : {};

      const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined =
        LOG_LEVELS[getLogLevel()] >= LOG_LEVELS.verbose
          ? {
            ...preCompactHook,
            ...verboseHooks,
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
          }
          : preCompactHook;

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
          append: getSystemPrompt(platform),
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

      agentStartTime = Date.now();
      eventBus.emit('agent:start', {
        chatId,
        model: effectiveModel,
        prompt: prompt.slice(0, 200),
        sessionId: existingSessionId,
        timestamp: agentStartTime,
      });

      const response = query({ prompt, options: queryOptions });

      // Expose as Cancellable for request-queue
      setActiveQuery(chatId, new QueryCancellable(response));

      for await (const responseMessage of response) {
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
              eventBus.emit('agent:tool_start', { chatId, toolName: block.name, input: toolInput, timestamp: Date.now() });
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
          eventBus.emit('agent:tool_end', { chatId, toolName: '', timestamp: Date.now() });
          onToolEnd?.();
        } else if (responseMessage.type === 'auth_status') {
          logAt('basic', '[Claude] Auth status', responseMessage);
        } else if (responseMessage.type === 'stream_event') {
          logAt('trace', '[Claude] Stream event', responseMessage.event);
        } else if (responseMessage.type === 'result') {
          logAt('basic', '[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
          gotResult = true;

          if ('session_id' in responseMessage && responseMessage.session_id) {
            this.chatSessionIds.set(chatId, responseMessage.session_id);
            sessionManager.setClaudeSessionId(chatId, responseMessage.session_id);
            logAt('basic', `[Claude] Stored session ${responseMessage.session_id} for chat ${chatId}`);
          }

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
            if (responseMessage.result && !fullText.includes(responseMessage.result)) {
              if (fullText.length > 0) {
                fullText += '\n\n';
              }
              fullText += responseMessage.result;
              onProgress?.(fullText);
            }
          } else if (responseMessage.subtype === 'error_during_execution' && isCancelled(chatId)) {
            fullText = '✅ Successfully cancelled - no tools or agents in process.';
            onProgress?.(fullText);
          } else {
            fullText = `Error: ${responseMessage.subtype}`;
            onProgress?.(fullText);
          }
        }
      }
    } catch (error: unknown) {
      if (isCancelled(chatId) || abortController?.signal.aborted) {
        eventBus.emit('agent:complete', {
          chatId,
          text: '✅ Cancelled',
          toolsUsed,
          durationMs: Date.now() - agentStartTime,
          timestamp: Date.now(),
        });
        return {
          text: '✅ Successfully cancelled - no tools or agents in process.',
          toolsUsed,
        };
      }

      if (gotResult && error instanceof Error && error.message.includes('exited with code')) {
        console.log('[Claude] Ignoring exit code error after successful result');
      } else {
        console.error('[Claude] Full error:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        eventBus.emit('agent:error', { chatId, error: errorMessage, timestamp: Date.now() });
        eventBus.emit('agent:complete', {
          chatId,
          text: '',
          toolsUsed,
          durationMs: Date.now() - agentStartTime,
          timestamp: Date.now(),
        });
        throw new Error(`Claude error: ${errorMessage}`);
      }
    }

    if (fullText && !abortController?.signal.aborted) {
      history.push({ role: 'assistant', content: fullText });
    }

    this.conversationHistory.set(chatId, history);

    if (resultUsage) {
      this.chatUsageCache.set(chatId, resultUsage);
    }

    eventBus.emit('agent:complete', {
      chatId,
      text: fullText.slice(0, 500),
      toolsUsed,
      usage: resultUsage,
      durationMs: Date.now() - agentStartTime,
      timestamp: Date.now(),
    });

    return {
      text: stripReasoningSummary(fullText) || 'No response from Claude.',
      toolsUsed,
      usage: resultUsage,
      compaction: compactionEvent,
      sessionInit: initEvent,
    };
  }

  clearConversation(chatId: number): void {
    this.conversationHistory.delete(chatId);
    this.chatSessionIds.delete(chatId);
    this.chatUsageCache.delete(chatId);
    contextMonitor.resetChat(chatId);
  }

  setModel(chatId: number, model: string): void {
    this.chatModels.set(chatId, model);
  }

  getModel(chatId: number): string {
    return this.chatModels.get(chatId) || 'opus';
  }

  clearModel(chatId: number): void {
    this.chatModels.delete(chatId);
  }

  getCachedUsage(chatId: number): AgentUsage | undefined {
    return this.chatUsageCache.get(chatId);
  }

  isDangerousMode(): boolean {
    return config.DANGEROUS_MODE;
  }
}
