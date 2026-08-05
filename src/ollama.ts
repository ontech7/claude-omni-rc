import { readFile } from 'node:fs/promises';

export interface OllamaDeps {
  baseUrl: string;
  transcribeModel: string;
  fetchImpl?: typeof fetch;
}

interface ShowResponse { capabilities?: string[]; }
interface ChatResponse { message?: { content?: Array<{ type?: string; text?: string }> } }

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

  // I modelli audio (es. gemma4:e2b/e4b) dichiarano la capability "audio".
  async hasAudio(model: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as ShowResponse;
    return (data.capabilities ?? []).includes('audio');
  }

  // La trascrizione passa da /api/chat con l'audio in base64 nel campo `images`:
  // whisper è stato rimosso dal registry di Ollama e i modelli audio attuali
  // (gemma4:e2b/e4b) trascrivono così. `think:false` evita il bug di Ollama che
  // svuota le risposte audio quando il thinking è attivo.
  async transcribe(audioPath: string): Promise<string> {
    const buf = await readFile(audioPath);
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.deps.transcribeModel,
        messages: [{ role: 'user', content: 'Transcribe the audio.', images: [buf.toString('base64')] }],
        stream: false,
        think: false,
        options: { think: false, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama /api/chat ${res.status}`);
    const data = (await res.json()) as ChatResponse;
    const text = (data.message?.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('empty transcription');
    return text;
  }
}
