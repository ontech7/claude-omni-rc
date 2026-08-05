import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import type { Config } from './config.js';
import type { SessionManager } from './sessions/manager.js';
import type { PermissionFlow } from './permissions.js';

export interface ApiDeps {
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  config: Config;
}

// API locale su loopback: la usa l'hook SessionStart (POST /api/attach), lo
// script del permission prompt tool (POST /api/permission) e, in Fase 2, l'app
// Expo. Nessuna autenticazione: ascolta solo su 127.0.0.1.
export interface ApiHandle { close(): Promise<void>; port(): number; ready: Promise<void>; }

// Risolve l'id sessione per una richiesta di permesso arrivata dal CLI: se il
// target tmux corrisponde a una sessione tracciata usa il suo id, altrimenti un
// id sintetico (non registra nulla nel registro — quello lo fa il TmuxWatcher).
function resolveSessionId(manager: SessionManager, provided: string | undefined): string {
  if (!provided) return 'term:unknown';
  const found = manager.findByTmuxTarget(provided) ?? manager.findByTmuxTarget(provided.replace(/^claude:/, ''));
  if (found) return found.id;
  return `term:${provided}`;
}

export function startApi(port: number, deps: ApiDeps): ApiHandle {
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/permission') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        // da disattivo o con richiesta malformata: fallback al prompt nativo.
        if (!deps.manager.isArmed()) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ask'); return; }
        let input: { toolName?: string; input?: unknown; sessionId?: string };
        try { input = JSON.parse(body); } catch { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ask'); return; }
        const toolName = input.toolName ?? 'tool';
        // AskUserQuestion non è una richiesta di permesso: il CLI mostra il menu
        // nel pane e la risposta arriva via tmux (bottoni della domanda). Auto-allow,
        // niente JSON + Approve/Reject in chat.
        if (toolName === 'AskUserQuestion') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('allow');
          return;
        }
        const sid = resolveSessionId(deps.manager, input.sessionId);
        // long-poll: la richiesta resta aperta finché l'utente non decide
        // (o scade PERMISSION_TIMEOUT_SECONDS → deny).
        const decision = await deps.permissionFlow.request(sid, toolName, (input.input ?? {}) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(decision.behavior === 'allow' ? 'allow' : 'deny');
      });
      return;
    }
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
