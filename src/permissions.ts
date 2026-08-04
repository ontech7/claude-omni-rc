import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.js';
import type { Config } from './config.js';
import type { PermissionRequest } from './types.js';

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

export interface PermissionFlowDeps {
  bus: Bus;
  config: Config;
  setStatus?: (sessionId: string, status: 'running' | 'waiting-permission') => void;
}

interface Pending {
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

export class PermissionFlow {
  private pending = new Map<string, Pending>();

  constructor(private deps: PermissionFlowDeps) {}

  request(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ behavior: 'deny', message: `Timeout ${this.deps.config.permissionTimeoutSeconds}s` });
      }, this.deps.config.permissionTimeoutSeconds * 1000);
      this.pending.set(id, { resolve, timer, sessionId });
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'Interrotto' });
        });
      }
      this.deps.setStatus?.(sessionId, 'waiting-permission');
      const req: PermissionRequest = {
        id, sessionId, toolName, input, createdAt: new Date().toISOString(),
      };
      this.deps.bus.emit({ type: 'session.permission', permission: req });
    });
  }

  approve(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'allow' });
    return true;
  }

  deny(id: string, message = "Rifiutato dall'utente"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'deny', message });
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: 'Sessione fermata' });
    }
  }
}
