import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/input.js';

const transcribeMock = vi.fn();
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function makeInbox() {
  const dir = mkdtempSync(join(tmpdir(), 'orc-inbox-'));
  const ollama = { transcribe: transcribeMock };
  return { inbox: new Inbox({ dir, ollama: ollama as any }), dir };
}

function fakeFfmpeg(ok = true) {
  return { on: (ev: string, cb: any) => { if (ev === 'close') setImmediate(() => cb(ok ? 0 : 1)); }, };
}

describe('Inbox', () => {
  beforeEach(() => { transcribeMock.mockReset(); spawnMock.mockReset(); });

  it('saves attachments with a sanitized timestamped name', async () => {
    const { inbox, dir } = makeInbox();
    const path = await inbox.saveAttachment(Buffer.from('hello'), 'a b!/c.png');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(path).not.toMatch(/[^a-zA-Z0-9._\-\/]/);
  });

  it('converts ogg to wav and transcribes via Ollama', async () => {
    const { inbox } = makeInbox();
    transcribeMock.mockResolvedValue('testo trascritto');
    spawnMock.mockImplementation((cmd: string, args: string[], _o: any) => {
      expect(cmd).toBe('ffmpeg');
      expect(args).toContain('-ar'); expect(args).toContain('16000');
      return fakeFfmpeg(true);
    });
    await expect(inbox.voiceToText('/tmp/msg.ogg')).resolves.toBe('testo trascritto');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when ffmpeg fails', async () => {
    const { inbox } = makeInbox();
    spawnMock.mockImplementation(() => fakeFfmpeg(false));
    await expect(inbox.voiceToText('/tmp/msg.ogg')).rejects.toThrow('ffmpeg');
  });
});
