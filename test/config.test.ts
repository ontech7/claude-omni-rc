import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies spec defaults', () => {
    const c = loadConfig({});
    expect(c.telegramBotToken).toBe('');
    expect(c.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(c.defaultModel).toBe('deepseek-v4-flash:0731-cloud');
    expect(c.apiPort).toBe(4123);
    expect(c.maxHeadlessSessions).toBe(2);
    expect(c.permissionTimeoutSeconds).toBe(120);
    expect(c.armedOnStart).toBe(false);
    expect(c.stateDir).toBe(`${process.env.HOME}/.ollama-rc`);
    expect(c.inboxDir).toBe(`${process.env.HOME}/.ollama-rc/inbox`);
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
  it('falls back on malformed numbers', () => {
    expect(loadConfig({ MAX_HEADLESS_SESSIONS: 'nope' }).maxHeadlessSessions).toBe(2);
  });
});
