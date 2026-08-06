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
      signal: AbortSignal.timeout(10_000), // Ollama irraggiungibile non deve stallare
    });
    if (!res.ok) throw new Error(`Ollama /api/show ${res.status}`);
    const data = (await res.json()) as ShowResponse;
    return (data.capabilities ?? []).includes('vision');
  }

  // Lunghezza del context del modello (`ollama show` → model_info.*.context_length),
  // usata per CLAUDE_CODE_MAX_CONTEXT_TOKENS come fa `ollama launch claude`.
  // Best-effort: se il modello non risponde o manca la chiave, undefined.
  async modelContext(model: string): Promise<number | undefined> {
    try {
      const res = await this.fetchImpl(`${this.deps.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(10_000), // Ollama irraggiungibile non deve stallare
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { model_info?: Record<string, unknown> };
      for (const [key, value] of Object.entries(data.model_info ?? {})) {
        if (key.endsWith('.context_length') && typeof value === 'number') return value;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // Nomi dei modelli locali (`ollama list`): usati per distinguere le sessioni
  // Ollama da quelle Anthropic-hosted nel TranscriptWatcher.
  async listModels(): Promise<Set<string>> {
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(10_000), // Ollama irraggiungibile non deve stallare
    });
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
