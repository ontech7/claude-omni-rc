import { writeFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaClient } from '../src/ollama.js';

// il transcribe legge il file da disco: va creato prima di ogni test
beforeEach(() => writeFileSync('/tmp/voice.wav', 'fake-audio'));

function fakeFetch(routes: Array<{ url: string; body?: unknown; ok?: boolean; status?: number }>) {
  const calls: Array<{ url: string; method?: string; body?: string | FormData }> = [];
  const fetchImpl: any = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as any });
    const route = routes.shift()!;
    expect(url.endsWith(route.url)).toBe(true);
    if (!route.ok) return new Response(JSON.stringify({ error: 'x' }), { status: route.status ?? 500 });
    return new Response(JSON.stringify(route.body));
  };
  return { fetchImpl, calls };
}

describe('OllamaClient', () => {
  it('detects vision via /api/show capabilities', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { capabilities: ['vision', 'tools'] } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'whisper-large-v3', fetchImpl });
    await expect(client.hasVision('kimi-k3:cloud')).resolves.toBe(true);
  });
  it('returns false for models without vision', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { capabilities: ['tools'] } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'x', fetchImpl });
    await expect(client.hasVision('qwen2.5:7b')).resolves.toBe(false);
  });
  it('throws when /api/show fails', async () => {
    const { fetchImpl } = fakeFetch([{ url: '/api/show', ok: false, status: 404 }]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'x', fetchImpl });
    await expect(client.hasVision('m')).rejects.toThrow('404');
  });
  it('transcribes via /api/transcribe and falls back to OpenAI-compatible route', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/transcribe', ok: false, status: 404 },
      { url: '/v1/audio/transcriptions', ok: true, body: { text: 'ciao mondo' } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'whisper-large-v3', fetchImpl });
    await expect(client.transcribe('/tmp/voice.wav')).resolves.toBe('ciao mondo');
  });
  it('throws when both endpoints fail', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/transcribe', ok: false, status: 500 },
      { url: '/v1/audio/transcriptions', ok: false, status: 500 },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'x', fetchImpl });
    await expect(client.transcribe('/tmp/voice.wav')).rejects.toThrow();
  });
});
