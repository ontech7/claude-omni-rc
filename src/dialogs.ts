import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.js';
import type { Config } from './config.js';
import type { UserDialog } from './types.js';

// Risposta a un request_user_dialog. `completed` consegna il `result` opaco al
// CLI (che lo interpreta in base al dialogKind); `cancelled` applica il
// comportamento di default del dialogo (obbligatorio per kind sconosciuti).
export type DialogDecision =
  | { behavior: 'completed'; result: unknown }
  | { behavior: 'cancelled' };

export interface DialogFlowDeps {
  bus: Bus;
  config: Config;
  setStatus?: (sessionId: string, status: 'running' | 'waiting-permission') => void;
  // C'è una chat Telegram a cui mandare il dialogo? Se no, chiedere non ha
  // senso: nessuno vedrebbe i bottoni e il turno resterebbe appeso fino al
  // timeout. Default: sì (nessun predicato configurato).
  canNotify?: () => boolean;
}

interface Pending {
  resolve: (d: DialogDecision) => void;
  timer?: NodeJS.Timeout; // parte con arm(), non alla creazione — vedi request()
  sessionId: string;
  dialogKind: string;
}

export class DialogFlow {
  private pending = new Map<string, Pending>();

  constructor(private deps: DialogFlowDeps) {}

  canNotify(): boolean { return this.deps.canNotify?.() ?? true; }

  // Il CLI parcheggia il turno finché il callback onUserDialog non risolve:
  // senza una chat collegata rispondere subito 'cancelled' è l'unica scelta
  // onesta — aspettare il timeout bloccherebbe il turno per minuti.
  request(
    sessionId: string,
    dialog: { dialogKind: string; payload: Record<string, unknown>; toolUseID?: string },
    signal?: AbortSignal,
  ): Promise<DialogDecision> {
    if (!this.canNotify()) {
      return Promise.resolve({ behavior: 'cancelled' });
    }
    return new Promise<DialogDecision>((resolve) => {
      const id = randomUUID();
      // Il timeout NON parte qui: se il bot tiene il dialogo in coda (sessione
      // non selezionata in Telegram) non deve scadere prima che l'utente l'abbia
      // anche solo visto — parte con arm(), chiamato quando viene davvero mostrato.
      this.pending.set(id, { resolve, sessionId, dialogKind: dialog.dialogKind });
      if (signal) {
        signal.addEventListener('abort', () => {
          const p = this.pending.get(id);
          if (!p) return;
          if (p.timer) clearTimeout(p.timer);
          this.pending.delete(id);
          resolve({ behavior: 'cancelled' });
        });
      }
      this.deps.setStatus?.(sessionId, 'waiting-permission');
      const full: UserDialog = { id, ...dialog };
      this.deps.bus.emit({ type: 'session.dialog', sessionId, dialog: full });
    });
  }

  // Fa partire il countdown di scadenza — va chiamato quando il dialogo viene
  // EFFETTIVAMENTE mostrato all'utente, mai alla creazione (vedi PermissionFlow.arm).
  arm(id: string): void {
    const p = this.pending.get(id);
    if (!p || p.timer) return;
    p.timer = setTimeout(() => {
      this.pending.delete(id);
      p.resolve({ behavior: 'cancelled' });
    }, this.deps.config.permissionTimeoutSeconds * 1000);
  }

  // Sessione a cui appartiene un dialogo pendente (per l'edit: il testo libero
  // va associato alla sessione giusta, non a quella attiva).
  sessionIdFor(id: string): string | undefined {
    return this.pending.get(id)?.sessionId;
  }

  complete(id: string, result: unknown): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'completed', result });
    return true;
  }

  cancel(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'cancelled' });
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ behavior: 'cancelled' });
    }
  }
}
