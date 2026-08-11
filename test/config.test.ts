import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies spec defaults', () => {
    const c = loadConfig({});
    expect(c.telegramBotToken).toBe('');
    expect(c.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(c.defaultModel).toBe('deepseek-v4-flash:cloud');
    expect(c.apiPort).toBe(4123);
    expect(c.maxHeadlessSessions).toBe(2);
    expect(c.permissionTimeoutSeconds).toBe(120);
    expect(c.armedOnStart).toBe(false);
    expect(c.defaultPermissionMode).toBe('standard'); // safe-by-default: /new chiede

    expect(c.stateDir).toBe(`${process.env.HOME}/.claude-omni-rc`);
    expect(c.inboxDir).toBe(`${process.env.HOME}/.claude-omni-rc/inbox`);
  });
  it('parses overrides', () => {
    const c = loadConfig({
      TELEGRAM_BOT_TOKEN: 'abc',
      ALLOWED_USER_IDS: '111, 222',
      PAIRING_CODE: 'secret',
      MAX_HEADLESS_SESSIONS: '5',
      PERMISSION_TIMEOUT_SECONDS: '30',
      ARMED_ON_START: 'true',
      WORKSPACE_DIRS: '~/proj1:/tmp/proj2',
    });
    expect(c.allowedUserIds).toEqual([111, 222]);
    expect(c.pairingCode).toBe('secret');
    expect(c.maxHeadlessSessions).toBe(5);
    expect(c.permissionTimeoutSeconds).toBe(30);
    expect(c.armedOnStart).toBe(true);
    expect(c.workspaceDirs).toEqual([`${process.env.HOME}/proj1`, '/tmp/proj2']);
  });
  it('accepts an explicit automode default', () => {
    expect(loadConfig({ DEFAULT_PERMISSION_MODE: 'auto' }).defaultPermissionMode).toBe('auto');
  });
  it('ignores a bogus permission mode and stays on standard', () => {
    expect(loadConfig({ DEFAULT_PERMISSION_MODE: 'yolo' }).defaultPermissionMode).toBe('standard');
  });
  it('falls back on malformed numbers', () => {
    expect(loadConfig({ MAX_HEADLESS_SESSIONS: 'nope' }).maxHeadlessSessions).toBe(2);
  });
});

describe('loadConfig — logging', () => {
  it('defaults to info level and a jsonl file under the state dir', () => {
    const c = loadConfig({});
    expect(c.logLevel).toBe('info');
    expect(c.logFile).toBe(`${process.env.HOME}/.claude-omni-rc/logs/daemon.jsonl`);
    expect(c.logMaxBytes).toBe(5_000_000);
    expect(c.logKeep).toBe(3);
  });
  it('follows STATE_DIR', () => {
    expect(loadConfig({ STATE_DIR: '/tmp/orc' }).logFile).toBe('/tmp/orc/logs/daemon.jsonl');
  });
  it('parses overrides', () => {
    const c = loadConfig({ LOG_LEVEL: 'debug', LOG_FILE: '/tmp/x.jsonl', LOG_MAX_BYTES: '1000', LOG_KEEP: '5' });
    expect(c.logLevel).toBe('debug');
    expect(c.logFile).toBe('/tmp/x.jsonl');
    expect(c.logMaxBytes).toBe(1000);
    expect(c.logKeep).toBe(5);
  });
  it('ignores a bogus level and stays on info', () => {
    expect(loadConfig({ LOG_LEVEL: 'chatty' }).logLevel).toBe('info');
  });
});
