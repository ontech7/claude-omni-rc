import { describe, it, expect } from 'vitest';
import { OllamaClient } from '../src/ollama.js';

function fakeFetch(routes: Array<{ url: string; body?: unknown; ok?: boolean; status?: number }>) {
  const fetchImpl: any = async (url: string, init?: RequestInit) => {
    const route = routes.shift()!;
    expect(url.endsWith(route.url)).toBe(true);
    if (!route.ok) return new Response(JSON.stringify({ error: 'x' }), { status: route.status ?? 500 });
    return new Response(JSON.stringify(route.body));
  };
  return { fetchImpl };
}

describe('OllamaClient', () => {
  it('detects vision via /api/show capabilities', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { capabilities: ['vision', 'tools'] } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await expect(client.hasVision('kimi-k3:cloud')).resolves.toBe(true);
  });
  it('returns false for models without vision', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { capabilities: ['tools'] } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await expect(client.hasVision('qwen2.5:7b')).resolves.toBe(false);
  });
  it('throws when /api/show fails', async () => {
    const { fetchImpl } = fakeFetch([{ url: '/api/show', ok: false, status: 404 }]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await expect(client.hasVision('m')).rejects.toThrow('404');
  });
  it('reads the model context length from /api/show model_info', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { model_info: { 'deepseek4.context_length': 1048576 } } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await expect(client.modelContext('deepseek-v4-flash:cloud')).resolves.toBe(1048576);
  });
  it('returns undefined when the context length is missing', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { model_info: { 'llama2.embedding_length': 4096 } } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await expect(client.modelContext('m')).resolves.toBeUndefined();
  });
  it('returns undefined when /api/show fails', async () => {
    const { fetchImpl } = fakeFetch([{ url: '/api/show', ok: false, status: 500 }]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await expect(client.modelContext('m')).resolves.toBeUndefined();
  });
  it('bounds the request with an AbortSignal timeout', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: any = async (_url: string, init?: RequestInit) => { captured = init; return new Response(JSON.stringify({ capabilities: ['vision'] })); };
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
    await client.hasVision('m');
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });
});
