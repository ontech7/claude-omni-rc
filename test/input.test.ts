import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/input.js';

function makeInbox() {
  const dir = mkdtempSync(join(tmpdir(), 'orc-inbox-'));
  return { inbox: new Inbox({ dir }), dir };
}

describe('Inbox', () => {
  it('saves attachments with a sanitized timestamped name', async () => {
    const { inbox, dir } = makeInbox();
    const path = await inbox.saveAttachment(Buffer.from('hello'), 'a b!/c.png');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(path).not.toMatch(/[^a-zA-Z0-9._\-\/]/);
  });
});
