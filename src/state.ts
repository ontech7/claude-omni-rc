import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session } from './types.js';

export interface StateFile {
  armed: boolean;
  authorizedUserIds: number[];
  sessions: Session[];
  mirrorOffsets: Record<string, number>;
  activeSessionId?: string; // sessione selezionata nel bot (persistita tra i riavvii)
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
      return { existed: exists, state: emptyState() };
    }
  }

  save(state: StateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
}
