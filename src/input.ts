import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface InboxDeps { dir: string; }

export class Inbox {
  constructor(private deps: InboxDeps) {
    mkdirSync(this.deps.dir, { recursive: true });
  }

  async saveAttachment(buf: Buffer, filename: string): Promise<string> {
    const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(this.deps.dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
    writeFileSync(path, buf);
    return path;
  }
}
