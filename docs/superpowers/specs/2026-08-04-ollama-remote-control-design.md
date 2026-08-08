# Ollama Remote Control — Design Document

**Data**: 2026-08-04
**Fase**: 1 — Daemon + Bot Telegram (MVP)
**Stato**: da revisionare da parte dell'utente

## 1. Obiettivo

Mimare il comportamento di `/remote-control` di Claude Code (Anthropic) quando i modelli sono serviti da **Ollama** (cloud o locale), senza dipendere dall'infrastruttura Anthropic. L'utente usa Claude Code come harness con `ANTHROPIC_BASE_URL=http://127.0.0.1:11434` (token fittizio `ollama`) e modelli `:cloud` come `deepseek-v4-flash:cloud` o `kimi-k3:cloud`.

Il remote control nativo è **architetturalmente incompatibile** con questa configurazione: dal v2.1.196 è disabilitato quando `ANTHROPIC_BASE_URL` non punta a `api.anthropic.com`, richiede un account claude.ai (piani Pro/Max/Team/Enterprise) e sincronizza i transcript sui server Anthropic.

**Criteri di successo** (confronto con `/rc`): vedere le sessioni dal telefono, chattarci, approvare/rifiutare i permessi da remoto, ricevere notifiche, riprendere dopo disconnessioni.

## 2. Vincoli e decisioni chiave

1. **Niente infrastruttura Anthropic**: solo harness locale + Ollama.
2. **Niente plugin Channels ufficiale**: richiede auth Anthropic, è un bridge single-session senza lista sessioni (verificato su doc ufficiali).
3. **Driver: Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — **validato da spike** sul Mac dell'utente (04/08/2026): funziona con `ANTHROPIC_BASE_URL` → Ollama per chat, tool call (Bash) **e flusso permessi** (`canUseTool`, percorsi allow e deny), con `deepseek-v4-flash:cloud`, senza identità Anthropic reale. Versione testata: **0.3.221** (da congelare).
4. **Due classi di sessione**:
   - **headless**: possedute dal daemon, controllabili al 100% (chat, media, permessi), via SDK con `resume` per `session_id`.
   - **terminale**: sessioni interattive dell'utente lanciate in tmux; **mirror** in lettura (tail dei JSONL) + **iniezione testo** via tmux.
5. **Bot Telegram** con long-polling in uscita (nessuna porta in ingresso, push gratis), **chat unica + switcher** di sessione.
6. **Niente streaming token-by-token**: progresso a milestone + `edit_message` throttlato.
7. **Verifica capabilities vision** del modello via `/api/show`: mai inoltrare blocchi immagine a modelli text-only.
8. **Concorrenza limitata** (default 2 sessioni headless attive): la quota cloud Ollama (finestra 5h + allowance settimanale) è una risorsa finita.
9. **Runtime**: Node 22, TypeScript, eseguito con `tsx`.
10. **Attivazione esplicita (interruttore globale)**: il remote control parte **disarmato**. L'utente lo attiva con `/rc on` dal bot Telegram o `ollama-rc on` da terminale; lo disattiva con `/rc off`. Da disattivo: nessun mirroring, nessuna iniezione, nessun relay — il bot risponde solo ai comandi di controllo (`/rc`, `/help`). Lo stato `armed` è persistito nel registry. Il daemon gira sempre (launchd), ma inerte finché non armato.

## 3. Architettura

```
ollama-rc/
├── src/
│   ├── daemon.ts            entry: avvio, config, shutdown, ripartenza
│   ├── config.ts            .env: token bot, allowlist, cap, modello, workdirs (porta API locale riservata alla Fase 2)
│   ├── sessions/
│   │   ├── manager.ts       registry unico: headless + terminali, stato, resume
│   │   ├── sdk-driver.ts    sessioni headless (query+resume, eventi SDK)
│   │   ├── mirror.ts        tailing JSONL ~/.claude/projects → output sessioni terminale
│   │   └── tmux-inject.ts   scrittura in sessioni terminale via tmux
│   ├── permissions.ts       permessi SDK → Approva/Rifiuta → canUseTool
│   ├── input.ts             allegati → inbox; vocali → trascrizione whisper
│   └── bus.ts               event bus pub/sub interno
└── bot/
    └── telegram.ts          client Bot API, comandi, inline keyboard, edit throttled
```

Flusso dati: `Telegram ↔ bot ↔ bus ↔ sessioni (SDK / tmux) ↔ Ollama`.

## 4. Modello dati

**Registry sessione** (persistito in `~/.ollama-rc/state.json`, insieme allo stato `armed` dell'interruttore globale):

```ts
type SessionKind = 'headless' | 'terminal';

interface Session {
  id: string;                 // uuid
  kind: SessionKind;
  title: string;              // progetto o titolo generato
  projectDir: string;         // workdir della sessione
  model?: string;
  status: 'idle' | 'running' | 'waiting-permission' | 'error' | 'stopped';
  claudeSessionId?: string;   // headless: chiave di resume SDK
  tmuxTarget?: string;        // terminale: "sessione:pane"
  lastActivity: string;       // ISO
  createdAt: string;
}
```

**Eventi bus** (tipi normalizzati, consumati dal bot): `session.updated` · `session.text` · `session.tool` (tool_use / tool_result) · `session.permission` · `session.result` · `session.error`.

**Scoperta sessioni terminale**: `tmux list-sessions` → nomi `claude:<progetto>` → abbinamento al JSONL più recente di `~/.claude/projects/<encoded-progetto>/`. Registrazione automatica al primo tail; `/attach <progetto>` come fallback manuale.

## 5. Driver headless (SDK)

- Ogni sessione headless = un'istanza SDK dedicata (`query({ prompt, options })`), con `session_id` salvato per `resume` (ripartenza daemon / riconnessione).
- Input: stream di messaggi utente per turni multipli nella stessa sessione.
- Eventi SDK → eventi bus (testo, tool, permessi, risultato).
- `model` dalla config; la modalità permessi è governata dal flusso permessi (Sezione 9).

## 6. Mirror JSONL

- Tail dei file `~/.claude/projects/*/*.jsonl`, parse delle righe (messaggi, tool call, risultati) → eventi `session.text` / `session.tool` per le sessioni terminale (e come fonte storica per tutte).
- Read-only: mai scrivere nei JSONL.
- **Gate di attivazione**: il mirroring è attivo solo quando l'interruttore globale è `armed`. Da disattivo non si leggono né espongono sessioni.
- Ripartenza: riattacco del tail dall'ultimo offset noto (offset persistito per file).

## 7. Iniezione tmux

- Invio testo → `tmux set-buffer` + `tmux paste-buffer -t <target> -p` (bracketed paste: testo letterale, multilinea, nessuna interpretazione shell).
- **Gate di sicurezza**: inietta solo se il mirror indica sessione idle (in attesa di input). Se occupata: coda con timeout o avviso "sessione occupata".
- Fallimento (pane scomparso, sessione tmux chiusa) → stato `error` + notifica.

## 8. Input media e voce

- **Allegati in ingresso** → scaricati in `~/.ollama-rc/inbox/`; per headless con modello vision vengono allegati al turno; per modelli text-only o sessioni terminale → riferimento al percorso + avviso (niente iniezione media nella TUI).
- **File in uscita** → i file prodotti dalla sessione vengono inviati come documenti Telegram (entro i limiti del Bot API).
- **Voce** → download (ogg) → conversione wav (ffmpeg) → trascrizione via **whisper di Ollama** (modello configurabile, es. `whisper-large-v3`) → iniezione come testo.

## 9. Permessi

- Il SDK (headless) chiede un permesso → il daemon intercetta (`canUseTool`) e inoltra al bot: messaggio con bottoni `[✓ Approva] [✗ Rifiuta]` + nome tool + input riassunto.
- La risposta dell'utente risolve la richiesta di permesso.
- **Validato da spike**: `{ behavior: 'allow' }` esegue la tool; `{ behavior: 'deny', message }` la blocca (`tool_result` con `is_error=true`) e il modello viene informato. Il callback scatta solo sulle decisioni "ask": le tool coperte da regole di allowlist (es. la tua `~/.claude/settings.json`) non generano notifiche. `opts` espone `displayName` (es. "Bash") ma non sempre `title` → l'UI Telegram renderizza da nome tool + input.
- **Timeout di sicurezza** (`PERMISSION_TIMEOUT_SECONDS`, default 120) → deny.
- Le sessioni terminale non hanno un flusso permessi separato: ereditano i permessi della propria sessione interattiva (già gestiti dal TUI locale).

## 10. Bot Telegram

- **Comandi**: `/start` (intro + pairing) · `/rc on` / `/rc off` / `/rc status` (interruttore globale) · `/sessions` (lista + switcher) · `/new <testo>` (crea headless e inietta) · `/stop` · `/status` · `/attach <progetto>` · `/help`.
- **Routing**: i messaggi testuali vanno alla sessione attiva della chat (default: ultima creata) **solo quando l'interruttore è attivo**; da disattivo, il bot risponde esclusivamente ai comandi di controllo (`/rc`, `/help`).
- **Pairing / security**: allowlist a un solo utente via codice di pairing; default-deny.
- **Progresso**: milestone con `edit_message` throttlato (~1/s); parse_mode **HTML** (più tollerante di MarkdownV2 per i blocchi di codice).
- **Client**: grammy (TypeScript-first) — scelta da confermare in implementazione.

## 11. Configurazione

`.env` (o variabili ambiente): `TELEGRAM_BOT_TOKEN` · `ALLOWED_USER_IDS` · `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) · `DEFAULT_MODEL` (default `deepseek-v4-flash:cloud`) · `WHISPER_MODEL` · `MAX_HEADLESS_SESSIONS` (2) · `PERMISSION_TIMEOUT_SECONDS` (120) · `WORKSPACE_DIRS` · `STATE_DIR` (`~/.ollama-rc`) · `ARMED_ON_START` (default `false`).

## 12. Errori e casi limite

| Caso | Comportamento |
|---|---|
| Ollama giù / quota cloud esaurita | errore sessione → notifica; stato `error`, resume possibile |
| Modello non vision + immagine | niente allegato al turno; avviso |
| Crash del daemon | launchd riavvia; headless in resume; terminale intatta (la possiede tmux), mirror riattacca il tail |
| Rate-limit Telegram | backoff + retry |
| Permesso senza risposta | timeout → deny |
| Iniezione tmux non sicura (sessione occupata) | coda/avviso, mai iniezione alla cieca |
| Remote control disattivato (`armed: false`) | nessun mirror/iniezione/relay; il bot risponde solo a `/rc` e `/help` |

## 13. Testing

- **Unit**: registry, bus, parser JSONL del mirror, tmux-inject (tmux mockato), flusso permessi.
- **Integration**: SDK + Ollama (spike già verificato), bot Telegram con token di test, tmux reale.
- **E2E manuale**: chat da telefono, permesso da telefono, vocale, media, iniezione in sessione terminale.

## 14. Deployment

- **launchd agent** (`~/Library/LaunchAgents/com.ontech7.ollama-rc.plist`), sempre attivo, riparte da solo; log su file con rotazione.
- Convenzione d'uso: sessioni interattive lanciate come `tmux new -s claude:<progetto>` → poi `claude` dentro.
- Segreti in `.env` (mai committati).

## 15. Fuori scope (fasi successive)

- **Fase 2**: app Expo (client dell'API locale del daemon, raggiungibile via LAN o Tailscale).
- **Fase 3**: integrazione quota `ollama-usage` (consumo 5h/settimanale mostrato in bot/app).
- Multi-utente; canali non-Telegram.

## 16. Rischi aperti

- ~~Flusso permessi via SDK (`canUseTool`) con Ollama~~ — **RISOLTO**: validato da spike (04/08/2026), percorsi allow e deny con `deepseek-v4-flash:cloud`. Nota operativa: con `permissionMode: 'default'` il callback copre le decisioni "ask"; per hard-deny headless esiste `dontAsk` (non usato, il design vuole l'approvazione remota).
- **Affidabilità iniezione tmux**: l'euristica "idle" va tarata in E2E.
- **Modello whisper da scaricare** su Ollama locale (la dimensione dipende dalla variante: large ~1.5GB+, small ~50MB).
- **Churn API SDK** (feature in preview): congelare la versione 0.3.221 validata dallo spike.
