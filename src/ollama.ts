export interface OllamaDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ShowResponse { capabilities?: string[]; }
interface TagsResponse { models?: { name?: string; model?: string }[]; }

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

  // Nomi dei modelli locali (`ollama list`): usati per distinguere le sessioni
  // Ollama da quelle Anthropic-hosted nel TranscriptWatcher.
  async listModels(): Promise<Set<string>> {
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
    const data = (await res.json()) as TagsResponse;
    const out = new Set<string>();
    for (const m of data.models ?? []) {
      if (m.name) out.add(m.name);
      if (m.model) out.add(m.model);
    }
    return out;
  }
}
