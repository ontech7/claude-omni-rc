import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.js';
import type { Config } from './config.js';
import type { PermissionRequest } from './types.js';

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface PermissionFlowDeps {
  bus: Bus;
  config: Config;
  setStatus?: (sessionId: string, status: 'running' | 'waiting-permission') => void;
  // C'è una chat Telegram a cui mandare la richiesta? Se no, chiedere non ha
  // senso: nessuno vedrebbe i bottoni e il chiamante resterebbe appeso fino al
  // timeout. Default: sì (nessun predicato configurato).
  canNotify?: () => boolean;
}

interface Pending {
  resolve: (d: PermissionDecision) => void;
  timer?: NodeJS.Timeout; // parte con arm(), non alla creazione — vedi request()
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export class PermissionFlow {
  private pending = new Map<string, Pending>();

  constructor(private deps: PermissionFlowDeps) {}

  canNotify(): boolean { return this.deps.canNotify?.() ?? true; }

  request(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    // Nessuna chat collegata: rispondere subito è l'unica scelta onesta —
    // aspettare il timeout bloccherebbe il turno per minuti per poi negare.
    if (!this.canNotify()) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'No Telegram chat is connected: send a message to the bot first.',
      });
    }
    return new Promise<PermissionDecision>((resolve) => {
      const id = randomUUID();
      // Il timeout NON parte qui: se il bot tiene la richiesta in coda (sessione
      // non selezionata in Telegram) non deve scadere prima che l'utente l'abbia
      // anche solo vista — parte con arm(), chiamato quando la richiesta viene
      // davvero mostrata.
      this.pending.set(id, { resolve, sessionId, toolName, input });
      if (signal) {
        signal.addEventListener('abort', () => {
          const p = this.pending.get(id);
          if (!p) return;
          if (p.timer) clearTimeout(p.timer);
          this.pending.delete(id);
          resolve({ behavior: 'deny', message: 'Interrupted' });
        });
      }
      this.deps.setStatus?.(sessionId, 'waiting-permission');
      const req: PermissionRequest = {
        id, sessionId, toolName, input, createdAt: new Date().toISOString(),
      };
      this.deps.bus.emit({ type: 'session.permission', permission: req });
    });
  }

  // Fa partire il countdown di scadenza: va chiamato quando la richiesta viene
  // EFFETTIVAMENTE mostrata all'utente (subito se la sessione è quella attiva in
  // Telegram, più tardi se era in coda) — mai alla creazione, altrimenti una
  // richiesta tenuta in coda scadrebbe prima che l'utente la veda mai. No-op se
  // già armata o già risolta.
  arm(id: string): void {
    const p = this.pending.get(id);
    if (!p || p.timer) return;
    p.timer = setTimeout(() => {
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: `Timeout ${this.deps.config.permissionTimeoutSeconds}s` });
    }, this.deps.config.permissionTimeoutSeconds * 1000);
  }

  // Tool, input e sessione della richiesta pendente (per ExitPlanMode: il piano
  // da confermare o modificare). Undefined se già risolta o scaduta.
  infoFor(id: string): { sessionId: string; toolName: string; input: Record<string, unknown> } | undefined {
    const p = this.pending.get(id);
    return p ? { sessionId: p.sessionId, toolName: p.toolName, input: p.input } : undefined;
  }

  // `updatedInput` serve a ExitPlanMode: approvare conferma il piano (input
  // originale) o lo sostituisce con quello modificato dall'utente.
  approve(id: string, updatedInput?: Record<string, unknown>): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve(updatedInput ? { behavior: 'allow', updatedInput } : { behavior: 'allow' });
    return true;
  }

  deny(id: string, message = 'Rejected by the user'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'deny', message });
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: 'Session stopped' });
    }
  }
}
