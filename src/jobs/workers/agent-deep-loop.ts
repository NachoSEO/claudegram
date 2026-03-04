import type { JobHandler } from '../core/job-types';
import { sendLoopToAgent } from '../../claude/agent.js';
import { discordChatId } from '../../discord/id-mapper.js';

export type AgentDeepLoopPayload = {
  userId?: string;
  chatId?: number;
  task: string;
  model?: string;
  maxIterations?: number;
};

export const agentDeepLoopJob = (payload: AgentDeepLoopPayload): JobHandler => {
  return async (ctx) => {
    const chatId =
      typeof payload.chatId === 'number'
        ? payload.chatId
        : payload.userId
          ? discordChatId(payload.userId)
          : (() => {
              throw new Error('agentDeepLoopJob requires chatId or userId');
            })();
    const loopAbort = new AbortController();

    const onCancel = () => loopAbort.abort();
    ctx.signal.addEventListener('abort', onCancel);

    const started = Date.now();
    const heartbeat = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      ctx.progress(`running-${secs}s`);
    }, 30_000);

    try {
      ctx.progress('hydrating-context');
      ctx.log('info', `Starting agent deep loop for chat ${chatId}${payload.userId ? ` (user ${payload.userId})` : ''}`);

      const response = await sendLoopToAgent(chatId, payload.task, {
        model: payload.model,
        maxIterations: payload.maxIterations ?? 24,
        abortController: loopAbort,
        onProviderEvent: (event) => {
          const safe = JSON.stringify(event.data ?? {});
          ctx.log('info', `[provider:${event.type}] ${safe}`);
        },
        onIterationComplete: (iteration, text) => {
          const preview = text.replace(/\s+/g, ' ').slice(0, 240);
          ctx.progress(`iteration-${iteration}`);
          ctx.log('info', `Iteration ${iteration} complete: ${preview}`);
        },
      });

      const preview = response.text.replace(/\s+/g, ' ').slice(0, 1200);
      ctx.progress('done');
      ctx.log('info', `Final summary: ${preview}`);
      return { exitCode: 0 };
    } finally {
      clearInterval(heartbeat);
      ctx.signal.removeEventListener('abort', onCancel);
    }
  };
};
