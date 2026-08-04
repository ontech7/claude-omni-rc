import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import type { OllamaClient } from './ollama.js';

export interface InboxDeps { dir: string; ollama: OllamaClient; }

export class Inbox {
  constructor(private deps: InboxDeps) {
    mkdirSync(this.deps.dir, { recursive: true });
  }

  async saveAttachment(buf: Buffer, filename: string): Promise<string> {
    const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    // suffisso di unicità: due save nello stesso millisecondo non si sovrascrivono
    const path = join(this.deps.dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
    writeFileSync(path, buf);
    return path;
  }

  async voiceToText(oggPath: string): Promise<string> {
    const wavPath = oggPath.replace(/\.ogg$/, '.wav');
    await this.convertOggToWav(oggPath, wavPath);
    return this.deps.ollama.transcribe(wavPath);
  }

  private convertOggToWav(src: string, dst: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', dst]);
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
  }
}
