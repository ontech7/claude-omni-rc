import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isOllamaProvider, resolveProvider, isAnthropicModel, fetchOllamaUsage, fetchAnthropicUsage } from '../src/usage.js';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

describe('isAnthropicModel', () => {
  it('matches claude-* models and the opus/sonnet/haiku/fable aliases', () => {
    for (const m of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-fable-5', 'opus', 'sonnet', 'haiku', 'fable']) {
      expect(isAnthropicModel(m)).toBe(true);
    }
  });
  it('does not match Ollama models', () => {
    for (const m of ['deepseek-v4-flash:0731-cloud', 'llama3.1', 'qwen2.5']) {
      expect(isAnthropicModel(m)).toBe(false);
    }
  });
});

describe('resolveProvider', () => {
  it('is ollama for a non-Anthropic model with no explicit base URL', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(resolveProvider(config, 'deepseek-v4-flash:0731-cloud', {})).toBe('ollama');
  });
  it('is anthropic for a claude-* model even with no explicit base URL', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(resolveProvider(config, 'claude-sonnet-5', {})).toBe('anthropic');
  });
  it('is custom when ANTHROPIC_BASE_URL points elsewhere, for any model', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(resolveProvider(config, 'deepseek-v4-flash:0731-cloud', { ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe('custom');
    expect(resolveProvider(config, 'claude-sonnet-5', { ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe('custom');
  });
  it('is anthropic for a claude-* model even when ANTHROPIC_BASE_URL is the Ollama URL', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(resolveProvider(config, 'claude-sonnet-5', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' })).toBe('anthropic');
  });
});

describe('isOllamaProvider', () => {
  it('is true when ANTHROPIC_BASE_URL is unset and the model is not Anthropic', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(isOllamaProvider(config, 'deepseek-v4-flash:0731-cloud', {})).toBe(true);
  });
  it('is false when ANTHROPIC_BASE_URL points elsewhere', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(isOllamaProvider(config, 'deepseek-v4-flash:0731-cloud', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false);
  });
  it('is true when ANTHROPIC_BASE_URL explicitly matches the Ollama URL', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(isOllamaProvider(config, 'deepseek-v4-flash:0731-cloud', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' })).toBe(true);
  });
  it('is false for an Anthropic model even with ANTHROPIC_BASE_URL unset', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(isOllamaProvider(config, 'claude-sonnet-5', {})).toBe(false);
  });
  it('is false for an Anthropic model even when ANTHROPIC_BASE_URL is the Ollama URL', () => {
    const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    expect(isOllamaProvider(config, 'claude-sonnet-5', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' })).toBe(false);
  });
});

describe('fetchOllamaUsage', () => {
  it('reports not-installed on ENOENT', async () => {
    const sh = vi.fn(async () => { const e: any = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; });
    const result = await fetchOllamaUsage(sh as any);
    expect(result).toEqual({ kind: 'not-installed' });
  });

  it('reports needs-auth on exit code 2', async () => {
    const sh = vi.fn(async () => ({ code: 2, stdout: '', stderr: 'no session' }));
    const result = await fetchOllamaUsage(sh as any);
    expect(result).toEqual({ kind: 'needs-auth' });
  });

  it('reports error on other non-zero exit codes', async () => {
    const sh = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'network down' }));
    const result = await fetchOllamaUsage(sh as any);
    expect(result).toEqual({ kind: 'error', message: 'network down' });
  });

  it('parses the JSON windows on success', async () => {
    const windows = { '5h': { identifier: '5h', pct_used: 42.5, reset_at: '2026-08-07T16:30:00Z' }, weekly: { identifier: 'weekly', pct_used: 12 } };
    const sh = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(windows), stderr: '' }));
    const result = await fetchOllamaUsage(sh as any);
    expect(result).toEqual({ kind: 'ok', windows });
  });
});

describe('fetchAnthropicUsage', () => {
  it('returns unavailable when the plan has no rate limits (API key auth)', async () => {
    const stream = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({ rate_limits_available: false, rate_limits: null })),
      return: vi.fn(async () => {}),
    };
    queryMock.mockReturnValueOnce(stream);
    const result = await fetchAnthropicUsage();
    expect(result).toEqual({ kind: 'unavailable' });
    expect(stream.return).toHaveBeenCalled();
  });

  it('returns the 5h/7d windows when available', async () => {
    const stream = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 23, resets_at: '2026-08-07T20:00:00Z' },
          seven_day: { utilization: 41, resets_at: '2026-08-10T00:00:00Z' },
        },
      })),
      return: vi.fn(async () => {}),
    };
    queryMock.mockReturnValueOnce(stream);
    const result = await fetchAnthropicUsage();
    expect(result).toEqual({
      kind: 'ok',
      fiveHour: { utilization: 23, resetsAt: '2026-08-07T20:00:00Z' },
      sevenDay: { utilization: 41, resetsAt: '2026-08-10T00:00:00Z' },
    });
  });

  it('never throws when the control call rejects, and still closes the stream', async () => {
    const stream = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => { throw new Error('control channel closed'); }),
      return: vi.fn(async () => {}),
    };
    queryMock.mockReturnValueOnce(stream);
    const result = await fetchAnthropicUsage();
    expect(result).toEqual({ kind: 'error', message: 'control channel closed' });
    expect(stream.return).toHaveBeenCalled();
  });
});
