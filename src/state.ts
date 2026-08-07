import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session } from './types.js';

export interface StateFile {
  armed: boolean;
  authorizedUserIds: number[];
  sessions: Session[];
  mirrorOffsets: Record<string, number>;
  activeSessionId?: string; // sessione selezionata nel bot (persistita tra i riavvii)
  // Chat Telegram verso cui il daemon notifica. Persistita: senza, dopo un
  // riavvio il daemon non saprebbe dove mandare le richieste di permesso e ogni
  // prompt del CLI resterebbe appeso fino al timeout (→ deny automatico).
  chatId?: number;
}

export function emptyState(): StateFile {
  return { armed: false, authorizedUserIds: [], sessions: [], mirrorOffsets: {} };
}

export class StateStore {
  constructor(private filePath: string) {}

  load(): { state: StateFile; existed: boolean } {
    const exists = existsSync(this.filePath);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StateFile>;
      return {
        existed: true,
        state: {
          ...emptyState(),
          ...parsed,
          authorizedUserIds: parsed.authorizedUserIds ?? [],
          sessions: parsed.sessions ?? [],
          mirrorOffsets: parsed.mirrorOffsets ?? {},
        },
      };
    } catch {
      // Stato illeggibile: ripartire da zero è inevitabile, ma il file NON va
      // perso in silenzio — dentro ci sono le sessioni e gli utenti autorizzati,
      // e il primo save() lo sovrascriverebbe. Lo mettiamo da parte e lo diciamo.
      if (exists) this.preserveCorrupt();
      return { existed: exists, state: emptyState() };
    }
  }

  private preserveCorrupt(): void {
    const backup = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(this.filePath, backup);
      console.error(`claude-omni-rc: unreadable ${this.filePath} — kept a copy at ${backup}, starting from an empty state.`);
    } catch (e) {
      console.error(`claude-omni-rc: unreadable ${this.filePath} and could not back it up:`, e);
    }
  }

  // Scrittura atomica: il file finale compare solo quando è completo. Con la
  // sola writeFileSync un crash a metà (persist() gira a ogni cambio dei
  // watcher) lascerebbe JSON troncato → sessioni e utenti autorizzati persi.
  save(state: StateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.filePath);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* già sparito */ }
      throw e;
    }
  }
}
