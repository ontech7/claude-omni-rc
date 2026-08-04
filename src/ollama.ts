import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface OllamaDeps {
  baseUrl: string;
  whisperModel: string;
  fetchImpl?: typeof fetch;
}

interface ShowResponse { capabilities?: string[]; }

export class OllamaClient {
  private fetchImpl: typeof fetch;

  constructor(private deps: OllamaDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async hasVision(model: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error(`Ollama /api/show ${res.status}`);
    const data = (await res.json()) as ShowResponse;
    return (data.capabilities ?? []).includes('vision');
  }

  async transcribe(audioPath: string): Promise<string> {
    const buf = await readFile(audioPath);
    const name = basename(audioPath);
    const mime = name.endsWith('.wav') ? 'audio/wav' : 'audio/ogg';
    const form = new FormData();
    form.append('model', this.deps.whisperModel);
    form.append('file', new Blob([buf], { type: mime }), name);
    const endpoints = ['/api/transcribe', '/v1/audio/transcriptions'];
    let lastErr: unknown = new Error('transcription failed');
    for (const ep of endpoints) {
      try {
        const res = await this.fetchImpl(`${this.deps.baseUrl}${ep}`, { method: 'POST', body: form });
        if (!res.ok) { lastErr = new Error(`Ollama ${ep} ${res.status}`); continue; }
        const data = (await res.json()) as { text?: string };
        return data.text ?? '';
      } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
