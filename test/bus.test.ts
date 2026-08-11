import { describe, it, expect, vi } from 'vitest';
import { Bus, newEventId } from '../src/bus.js';

describe('newEventId', () => {
  it('returns a short hex id', () => {
    expect(newEventId()).toMatch(/^[0-9a-f]{8}$/);
  });
  it('does not repeat across calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newEventId()));
    expect(ids.size).toBe(200);
  });
});

describe('Bus', () => {
  it('delivers matching events and supports unsubscribe', () => {
    const bus = new Bus();
    const a = vi.fn();
    const b = vi.fn();
    const off = bus.on('session.text', a);
    bus.on('session.text', b);
    bus.emit({ type: 'session.text', sessionId: 's1', role: 'assistant', text: 'ciao' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    off();
    bus.emit({ type: 'session.text', sessionId: 's1', role: 'assistant', text: 'x' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
  it('does not deliver to handlers of other types', () => {
    const bus = new Bus();
    const h = vi.fn();
    bus.on('session.permission', h);
    bus.emit({ type: 'session.error', sessionId: 's1', message: 'boom' });
    expect(h).not.toHaveBeenCalled();
  });
});
