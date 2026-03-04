import { AsyncLocalStorage } from 'node:async_hooks';
import type { JobOrigin } from '../jobs/core/job-types.js';

type ToolContext = {
  chatId: number;
  origin?: JobOrigin;
};

const toolContextStore = new AsyncLocalStorage<ToolContext>();

export async function runWithToolContext<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStore.run(ctx, fn);
}

export function getCurrentToolChatId(): number | undefined {
  return toolContextStore.getStore()?.chatId;
}

export function getCurrentToolOrigin(): JobOrigin | undefined {
  return toolContextStore.getStore()?.origin;
}
