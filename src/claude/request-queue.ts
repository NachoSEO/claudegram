import type { Query } from '@anthropic-ai/claude-agent-sdk';

type QueuedRequest<T> = {
  message: string;
  handler: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

const activeAbortControllers: Map<number, AbortController> = new Map();
const activeQueries: Map<number, Query> = new Map();
const pendingQueues: Map<number, Array<QueuedRequest<unknown>>> = new Map();
const processingFlags: Map<number, boolean> = new Map();

export function getAbortController(chatId: number): AbortController | undefined {
  return activeAbortControllers.get(chatId);
}

export function setAbortController(chatId: number, controller: AbortController): void {
  activeAbortControllers.set(chatId, controller);
}

export function clearAbortController(chatId: number): void {
  activeAbortControllers.delete(chatId);
}

export function setActiveQuery(chatId: number, q: Query): void {
  activeQueries.set(chatId, q);
}

export function clearActiveQuery(chatId: number): void {
  activeQueries.delete(chatId);
}

export function isProcessing(chatId: number): boolean {
  return processingFlags.get(chatId) === true;
}

export function getQueuePosition(chatId: number): number {
  const queue = pendingQueues.get(chatId);
  return queue ? queue.length : 0;
}

export async function queueRequest<T>(
  chatId: number,
  message: string,
  handler: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request: QueuedRequest<T> = {
      message,
      handler,
      resolve: resolve as (value: unknown) => void,
      reject,
    };

    let queue = pendingQueues.get(chatId);
    if (!queue) {
      queue = [];
      pendingQueues.set(chatId, queue);
    }
    queue.push(request as QueuedRequest<unknown>);

    processQueue(chatId);
  });
}

async function processQueue(chatId: number): Promise<void> {
  if (processingFlags.get(chatId)) {
    return;
  }

  const queue = pendingQueues.get(chatId);
  if (!queue || queue.length === 0) {
    return;
  }

  processingFlags.set(chatId, true);
  const request = queue.shift()!;

  try {
    const result = await request.handler();
    request.resolve(result);
  } catch (error) {
    request.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    processingFlags.set(chatId, false);
    clearAbortController(chatId);
    clearActiveQuery(chatId);

    if (queue.length > 0) {
      processQueue(chatId);
    }
  }
}

export async function cancelRequest(chatId: number): Promise<boolean> {
  const q = activeQueries.get(chatId);
  const controller = activeAbortControllers.get(chatId);

  if (q) {
    // Graceful SDK-level interrupt - stops subprocess cleanly
    try {
      await q.interrupt();
    } catch {
      // interrupt() may throw if query already finished
    }
    clearActiveQuery(chatId);
    clearAbortController(chatId);
    return true;
  }

  if (controller) {
    // Fallback to AbortController if no query stored
    controller.abort();
    clearAbortController(chatId);
    return true;
  }

  return false;
}

export function clearQueue(chatId: number): number {
  const queue = pendingQueues.get(chatId);
  if (!queue) return 0;

  const count = queue.length;
  for (const request of queue) {
    request.reject(new Error('Queue cleared'));
  }
  queue.length = 0;
  return count;
}
