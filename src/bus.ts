import type { BusEvent } from './types.js';

type Handler<T extends BusEvent['type']> = (e: Extract<BusEvent, { type: T }>) => void;

export class Bus {
  private handlers = new Map<BusEvent['type'], Set<Handler<BusEvent['type']>>>();

  on<T extends BusEvent['type']>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const anyHandler = handler as unknown as Handler<BusEvent['type']>;
    set.add(anyHandler);
    return () => { set.delete(anyHandler); };
  }

  emit(event: BusEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }
}
