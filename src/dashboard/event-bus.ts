import { EventEmitter } from 'events';
import type { DashboardEventMap, DashboardEventType } from './types.js';

class DashboardEventBus extends EventEmitter {
  emit<T extends DashboardEventType>(event: T, payload: DashboardEventMap[T]): boolean {
    return super.emit(event, payload);
  }

  on<T extends DashboardEventType>(event: T, listener: (payload: DashboardEventMap[T]) => void): this {
    return super.on(event, listener);
  }

  off<T extends DashboardEventType>(event: T, listener: (payload: DashboardEventMap[T]) => void): this {
    return super.off(event, listener);
  }
}

export const eventBus = new DashboardEventBus();
eventBus.setMaxListeners(50);
