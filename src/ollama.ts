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

  // Riassunto in una riga di una tool call, nella lingua della conversazione
  // (hint = ultimo messaggio utente). Usato dal bot per le notifiche tool:
  // niente JSON grezzo, testo naturale breve. Best-effort: se Ollama non
  // risponde entro 5s o restituisce vuoto, throw → il bot fa fallback.
  async summarize(model: string, toolName: string, input: Record<string, unknown>, languageHint?: string): Promise<string> {
    const args = JSON.stringify(input).slice(0, 500);
    const lang = languageHint
      ? `The user is chatting in this language: "${languageHint.slice(0, 200)}"\nUse that language for your reply.`
      : 'Use the language of the conversation.';
    const prompt = [
      'Write ONE short line (max 60 chars) describing what this tool call does.',
      'Use the actual arguments. No emoji, no quotes, no period, no markdown.',
      lang,
      '',
      `Tool: ${toolName}`,
      `Arguments: ${args}`,
      '',
      'Line:',
    ].join('\n');
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0, num_predict: 60 },
      }),
      signal: AbortSignal.timeout(5_000), // summary lenta → fallback, non blocca la bubble
    });
    if (!res.ok) throw new Error(`Ollama /api/generate ${res.status}`);
    const data = (await res.json()) as { response?: string };
    const line = (data.response ?? '').trim().replace(/\s+/g, ' ');
    if (!line) throw new Error('empty summary');
    return line.slice(0, 80);
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
