import { randomBytes } from 'node:crypto';
import type { BusEvent } from './types.js';

// Identità di un evento diretto a Telegram: lo accompagna dalla riga di
// transcript (o dallo stream dell'SDK) fino al messaggio consegnato, così un
// evento che non arriva si può cercare nel log invece di essere dedotto.
export function newEventId(): string {
  return randomBytes(4).toString('hex');
}

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
