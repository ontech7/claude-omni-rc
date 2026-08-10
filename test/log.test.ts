import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, serializeRecord, LOG_LEVELS, initLogger, log } from '../src/log.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'omni-log-'));
}

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('LOG_LEVELS', () => {
  it('lists the levels from the most to the least severe', () => {
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
  });
});

describe('serializeRecord', () => {
  it('produces one JSON line with timestamp, level, message and fields', () => {
    const line = serializeRecord(0, 'info', 'delivered', { sessionId: 'abc', eventId: 'e1' });
    expect(line.endsWith('\n')).toBe(true);
    const rec = JSON.parse(line);
    expect(rec).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'delivered',
      sessionId: 'abc',
      eventId: 'e1',
    });
  });

  it('expands an Error field into name, message and stack', () => {
    const rec = JSON.parse(serializeRecord(0, 'error', 'send failed', { err: new TypeError('boom') }));
    expect(rec.err.name).toBe('TypeError');
    expect(rec.err.message).toBe('boom');
    expect(typeof rec.err.stack).toBe('string');
  });

  it('degrades to a marker instead of throwing on a circular field', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rec = JSON.parse(serializeRecord(0, 'warn', 'weird', { payload: circular }));
    expect(rec.msg).toBe('weird');
    expect(rec.unserializable).toBe(true);
  });
});

describe('Logger', () => {
  it('writes a JSON line per record to the configured file', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'info', stderr: () => {} });
    logger.info('daemon starting', { pid: 1 });
    logger.close();
    expect(lines(file)).toEqual([
      expect.objectContaining({ level: 'info', msg: 'daemon starting', pid: 1 }),
    ]);
  });

  it('drops records below the configured level', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'warn', stderr: () => {} });
    logger.debug('noisy');
    logger.info('chatty');
    logger.warn('kept');
    logger.close();
    expect(lines(file).map(r => r.msg)).toEqual(['kept']);
  });

  it('merges the fields bound with child() into every record', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'info', stderr: () => {} });
    logger.child({ sessionId: 's1' }).info('event', { eventId: 'e1' });
    logger.close();
    expect(lines(file)[0]).toEqual(expect.objectContaining({ sessionId: 's1', eventId: 'e1' }));
  });

  it('mirrors error records to stderr so daemon.err.log stays a canary', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const seen: string[] = [];
    const logger = createLogger({ file, level: 'info', stderr: l => seen.push(l) });
    logger.info('quiet');
    logger.error('loud');
    logger.close();
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]).msg).toBe('loud');
  });

  it('rotates past maxBytes and keeps at most `keep` older files', () => {
    const dir = tmpDir();
    const file = join(dir, 'daemon.jsonl');
    // maxBytes minuscolo: ogni riga supera la soglia e forza una rotazione.
    const logger = createLogger({ file, level: 'info', maxBytes: 80, keep: 2, stderr: () => {} });
    for (let i = 0; i < 6; i++) logger.info(`record-${i}`, { padding: 'x'.repeat(40) });
    logger.close();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false); // oltre `keep` non si accumula
  });

  it('keeps recentErrors() for /diag, most recent last, capped', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'info', stderr: () => {} });
    logger.info('not an error');
    logger.warn('first');
    logger.error('second');
    const recent = logger.recentErrors();
    logger.close();
    expect(recent).toHaveLength(2);
    expect(JSON.parse(recent[0]).msg).toBe('first');
    expect(JSON.parse(recent[1]).msg).toBe('second');
  });

  it('stays silent instead of throwing when the log file cannot be opened', () => {
    const dir = tmpDir();
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'not a directory'); // mkdir sotto un file fallisce
    const logger = createLogger({ file: join(blocker, 'daemon.jsonl'), level: 'info', stderr: () => {} });
    expect(() => logger.info('survives')).not.toThrow();
    logger.close();
  });

  it('rotates based on UTF-8 byte count, not UTF-16 code units', () => {
    const dir = tmpDir();
    const file = join(dir, 'daemon.jsonl');
    // Emoji "🚀" is 2 UTF-16 code units but 4 UTF-8 bytes.
    // With 100 emoji: UTF-16 length ≈ 200 code units, UTF-8 bytes ≈ 400.
    // Plus JSON structure (msg, field names): ≈ 100 UTF-16 / 100 UTF-8.
    // Total: ≈ 300 UTF-16 code units, ≈ 500 UTF-8 bytes.
    // With maxBytes = 350:
    // - UTF-16 path: 0 + 300 < 350, does NOT rotate → file exists, file.1 does NOT exist
    // - UTF-8 path: 0 + 500 > 350, DOES rotate → file and file.1 both exist
    const logger = createLogger({ file, level: 'info', maxBytes: 350, stderr: () => {} });
    logger.info('test', { payload: '🚀'.repeat(100) });
    logger.close();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
  });
});

describe('log() and initLogger()', () => {
  it('log() returns a usable logger before initLogger is called', () => {
    const logger = log();
    expect(logger).toBeDefined();
    expect(() => logger.info('test message')).not.toThrow();
  });

  it('initLogger replaces the current instance', () => {
    const file1 = join(tmpDir(), 'file1.jsonl');
    const file2 = join(tmpDir(), 'file2.jsonl');

    // Get the initial logger and write to file1
    const logger1 = initLogger({ file: file1, level: 'info', stderr: () => {} });
    logger1.info('message1');
    logger1.close();

    // Replace with a new logger pointing to file2
    const logger2 = initLogger({ file: file2, level: 'info', stderr: () => {} });
    logger2.info('message2');
    logger2.close();

    // Verify that log() now returns a logger that writes to the new file
    const current = log();
    current.info('message3');
    current.close();

    expect(lines(file1).map(r => r.msg)).toEqual(['message1']);
    expect(lines(file2).map(r => r.msg)).toContain('message2');
  });

  it('log() returns the new instance after initLogger replaces it', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger1 = log();
    const logger2 = initLogger({ file, level: 'info', stderr: () => {} });
    const logger3 = log();

    // After initLogger, log() should return the new instance
    expect(logger3).toBe(logger2);
    logger2.close();
  });

  it('records written through log() land in the newly configured file', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    initLogger({ file, level: 'info', stderr: () => {} });
    log().info('written through log', { eventId: 'e1' });
    log().close();

    expect(lines(file)).toEqual([
      expect.objectContaining({ level: 'info', msg: 'written through log', eventId: 'e1' }),
    ]);
  });

  it('initLogger closes the previous instance to avoid descriptor leak', () => {
    const file1 = join(tmpDir(), 'file1.jsonl');
    const file2 = join(tmpDir(), 'file2.jsonl');

    const logger1 = initLogger({ file: file1, level: 'info', stderr: () => {} });
    logger1.info('message1');

    // Replace with new logger; this should close the sink of logger1
    const logger2 = initLogger({ file: file2, level: 'info', stderr: () => {} });

    // Write through old logger after replacement
    logger1.info('orphaned');
    logger2.info('message2');
    logger2.close();

    // Comportamento osservabile: il vecchio logger smette di scrivere al vecchio file
    // dopo che è stato sostituito. Non verifichiamo la chiusura OS-level del descrittore
    // (non osservabile da un test), ma il contratto comportamentale: il messaggio
    // "orphaned" non dovrebbe comparire nel file1 perché il sink è stato chiuso.
    const file1Contents = readFileSync(file1, 'utf8').trim().split('\n').filter(Boolean);
    expect(file1Contents).toHaveLength(1);
    expect(JSON.parse(file1Contents[0]).msg).toBe('message1');
    expect(file1Contents.some(line => JSON.parse(line).msg === 'orphaned')).toBe(false);
  });
});
