import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import type { SessionManager } from './sessions/manager.js';

export interface ApiDeps { manager: SessionManager; }

// API locale su loopback: la usa l'hook SessionStart (POST /api/attach) e, in
// Fase 2, l'app Expo. Nessuna autenticazione: ascolta solo su 127.0.0.1.
export interface ApiHandle { close(): Promise<void>; port(): number; ready: Promise<void>; }

export function startApi(port: number, deps: ApiDeps): ApiHandle {
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/attach') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const input = JSON.parse(body) as { projectDir?: string; tmuxTarget?: string; title?: string };
          if (!input.projectDir) throw new Error('projectDir is required');
          const session = deps.manager.registerTerminal({
            title: input.title ?? basename(input.projectDir),
            projectDir: input.projectDir,
            ...(input.tmuxTarget ? { tmuxTarget: input.tmuxTarget } : {}),
          });
          deps.manager.persist();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionId: session.id }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: deps.manager.list() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', e => { console.error('ollama-rc api:', (e as Error).message); });
  const ready = new Promise<void>(resolve => server.once('listening', resolve));
  server.listen(port, '127.0.0.1');
  return {
    port: () => (server.address() as { port: number }).port,
    close: () => new Promise(resolve => server.close(() => resolve())),
    ready,
  };
}
