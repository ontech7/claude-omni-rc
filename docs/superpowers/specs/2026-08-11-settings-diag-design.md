# Comando /settings + /diag arricchito — Design Document

**Data**: 2026-08-11
**Stato**: da revisionare da parte dell'utente
**Branch**: `feat/settings-diag` (worktree `.worktrees/settings-diag`, staccato da `main`)

## 1. Problema / obiettivi

Tre richieste dell'utente, in ordine di segnalazione:

1. **Comando `/settings`** — vedere tutti i settaggi utente da Telegram e poterli
   modificare, persistendo le modifiche in un file JSON dentro la folder di
   lavoro (es. `~/.claude-omni-rc`).
2. **`/diag` assente dal menù dei comandi Telegram** — il comando esiste e
   funziona via testo, ma non compare nell'autocomplete del client Telegram.
3. **`/diag` arricchito** — mostrare, per ogni sessione, **quale modello** sta
   usando, **con quale effort** e **su quale branch git** sta lavorando (se il
   progetto è sotto git).

**Criterio di successo**:
- `/settings` elenca e modifica le chiavi curate; le modifiche sopravvivono al
  riavvio e valgono al successivo riavvio del daemon.
- `/diag` compare nel menù `setMyCommands` (oltre a `/help`, che già lo elenca).
- `/diag` riporta per ogni sessione `model · effort · branch`, con `—` quando il
  dato non è disponibile, senza regressioni nei gate di sicurezza né nello
  streaming.

## 2. Situazione attuale

- **Config**: `src/config.ts` — `loadConfig(env)` è l'unico punto in cui si
  legge `process.env`; viene chiamato una sola volta all'avvio in `daemon.ts` e
  i componenti prendono ciò che serve nel costruttore (non-negoziabile del
  progetto: *config is read once*). Niente strato JSON di override.
- **Stato mutabile**: `src/state.ts` — `StateStore` legge/scrive `state.json`
  (in `STATE_DIR`, default `~/.claude-omni-rc`), scrittura atomica
  (tmp+rename), file corrotto preservato come `.corrupt-<ts>` e si riparte da
  stato vuoto.
- **Sessione** (`src/types.ts`): `Session` ha `id, kind, title, projectDir,
  model?, permissionMode?, status, claudeSessionId?, tmuxTarget?,
  transcriptFile?, lastActivity, createdAt`. Nessun campo effort/branch.
- **`/new`** (`bot/telegram.ts`): `parseNewFlags` gestisce `--auto|--standard`
  e `--model <name>`; `createHeadless` salva `model` e `permissionMode` sulla
  sessione; `SdkDriver.query()` parte con `model`, `cwd`, `permissionMode` e
  env del provider.
- **Modello sessioni terminali** (`src/sessions/tmux-inject.ts`): `claudeModel`
  legge `ps -o args= -p <pid>` e fa regex su `--model (\S+)` — best-effort,
  `undefined` se il processo non c'è o non ha il flag.
- **`/diag`** (`bot/telegram.ts`): `diagReport(DiagSnapshot)` mostra version,
  armed, chat bound, sessioni (kind/status/tmux/transcript), pending, recent
  errors. `DiagSession` non include model/effort/branch. Il menù
  `setMyCommands` (in `start()`) elenca 11 comandi ma **non `diag`**.
- **Skill di riferimento**: `.claude/skills/adding-a-bot-command.md` (4 posti
  dove vive la lista comandi: `setMyCommands`, `/help`, README, AI-GUIDE) e
  `.claude/skills/adding-a-config-option.md` (5 posti per una nuova chiave:
  `config.ts`, `.env.example`, tabella README, install.sh, `config.test.ts`).
- **SDK**: `@anthropic-ai/claude-agent-sdk` `query()` accetta
  `effort?: 'low'|'medium'|'high'|'xhigh'|'max' | number` a livello top.

## 3. Decisioni prese con l'utente

1. **Scope `/settings`**: sottoinsieme curato di chiavi, non tutte quelle di
   `.env`.
2. **Effetto delle modifiche**: al riavvio del daemon (`settings.json` è un
   layer fuso in `loadConfig()`), non hot-reload.
3. **Effort su `/diag`**: scoperta dai processi per le terminali **più** flag
   `/new --effort` per le headless.
4. **Resa `/diag`**: modello/effort/branch **per sessione** (ogni riga).
5. **UX `/settings`**: basato su argomenti (non bottoni inline).

## 4. Design

### 4.1 Storage: `settings.json`

- Percorso: `join(stateDir, 'settings.json')` → default
  `~/.claude-omni-rc/settings.json` (rispetta `STATE_DIR`).
- Nuovo modulo `src/settings.ts`:
  - `interface UserSettings` — sottoinsieme parziale delle chiavi curate.
  - `loadSettings(filePath): UserSettings` — file mancante → `{}`; JSON
    corrotto → backup `.corrupt-<ts>` e `{}` (stesso pattern di `state.ts`).
  - `saveSettings(filePath, settings): void` — scrittura atomica (tmp+rename),
    indentata come `state.json`.
  - Validazione sul lato sicuro: per ogni chiave nota, valore invalido →
    ignorato (si cade su .env/default); chiavi sconosciute ignorate.

### 4.2 Chiavi curate (sottoinsieme `/settings`)

| Chiave | Tipo | Fonte attuale | Note |
|---|---|---|---|
| `defaultModel` | string | `DEFAULT_MODEL` | modello delle nuove headless |
| `defaultPermissionMode` | `auto\|standard` | `DEFAULT_PERMISSION_MODE` | default `standard` (sicuro) |
| `maxHeadlessSessions` | int > 0 | `MAX_HEADLESS_SESSIONS` | cap sessioni headless |
| `permissionTimeoutSeconds` | int > 0 | `PERMISSION_TIMEOUT_SECONDS` | timeout permessi |
| `armedOnStart` | bool | `ARMED_ON_START` | armed al riavvio |
| `noUpdateCheck` | bool | `CLAUDE_OMNI_RC_NO_UPDATE_CHECK` | disabilita il check versione |
| `defaultEffort` | `low\|medium\|high\|xhigh` | **nuova** `DEFAULT_EFFORT` | effort default delle headless |

`defaultEffort` è una **nuova opzione di config** e segue la checklist
`adding-a-config-option` (5 posti): `src/config.ts`, `.env.example`, tabella
README, `test/config.test.ts`. Non serve in `install.sh` (non è una scelta da
primo avvio). Default: `medium`.

### 4.3 Precedenza e wiring in `loadConfig()`

**Precedenza: `settings.json` > `.env` > default hardcoded.** Senza questo,
`/settings` non potrebbe sovrascrivere una chiave già presente in `.env` e il
comando sarebbe inutile.

`loadConfig(env)` continua a essere l'unico punto di lettura: calcola
`stateDir` da env, carica `loadSettings(join(stateDir, 'settings.json'))` e per
ogni chiave curata fa `settings[key] ?? env[key] ?? default`. Il valore
risultante è quello che i componenti ricevono nei costruttori, invariato.
Effetto delle modifiche: **al riavvio del daemon** (il bot non riavvia il
daemon da solo: risponderebbe uccidendo il proprio turno; la conferma del bot
recita "✅ salvato — effetto al prossimo riavvio").

Nota di compatibilità: `state.json` esistente e `.env` esistenti non vengono
toccati; la precedenza non rompe installi già configurati (settings.json vuoto
= comportamento odierno).

### 4.4 Comando `/settings` (arg-based)

Funzioni pure esportate sopra la classe (testabili senza bot):

- `parseSettingsCommand(raw)` → `{ kind: 'all' }` | `{ kind: 'show', key }` |
  `{ kind: 'set', key, value }` | `{ kind: 'reset', key }` | `{ kind: 'invalid',
  error }`. Chiavi riconosciute solo quelle della tabella §4.2.
- `formatSettingsReport(settings, config)` → report HTML: per ogni chiave
  valore corrente + fonte (`settings.json` / `.env` / default) + nota
  "applies at next daemon restart".
- `formatSettingsKey(key)` → descrizione e valori ammessi per `/settings <key>`.

Handler `onSettings(ctx)`:
- Gate: `if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;` — il
  trio disarmed-only (`/rc`, `/help`, `/start`) resta invariato.
- `all` → report; `show` → chiave singola; `set` → valida (stesse regole di
  §4.1), salva via `saveSettings`, conferma; `reset` → rimuove la chiave dal
  JSON, conferma.
- Ogni frammento dinamico `htmlEscape`d; risposta via `this.send()`.

Dipendenze: il bot riceve nel costruttore `settingsFile` (path) e
`loadSettings`/`saveSettings` (per testabilità); il `config` corrente per
mostrare i valori .env/default.

### 4.5 Registrazione comando (4 posti — skill `adding-a-bot-command`)

1. `setMyCommands([...])` in `start()`: aggiungere
   `{ command: 'settings', description: 'View / change user settings' }` **e**
   `{ command: 'diag', description: 'Daemon diagnostics' }` (fix §4.6).
2. Stringa `/help` del handler `help`.
3. `README.md` → sezione Usage (riga comando + riga tabella config per
   `DEFAULT_EFFORT` e nota su `settings.json`).
4. `AI-GUIDE.md` → riga "Setup matrix" (user asks "check/change my settings
   from the phone" → `/settings`) + lista "Command reference".

### 4.6 Fix menù `/diag`

Aggiungere `{ command: 'diag', description: 'Daemon diagnostics' }` a
`setMyCommands`. Unica riga; la resa del comando non cambia (a parte §4.7).

### 4.7 `/diag` arricchito

**Modello**: `Session` guadagna `effort?: EffortLevel` (union
`'low'|'medium'|'high'|'xhigh'`) — persistito in `state.json` come `model`;
sessioni vecchie senza il campo → `undefined` → resa `—`.

**Effort — headless**:
- `parseNewFlags` accetta `--effort <low|medium|high|xhigh>` (valido solo per
  modelli che lo supportano; il valore viene passato all'SDK che decide).
- `createHeadless` accetta `effort?: EffortLevel`; default
  `config.defaultEffort` se presente.
- `SdkDriver.query()` passa `effort` nelle options quando la sessione lo ha
  (l'SDK lo supporta nativamente; per provider non-Claude l'SDK lo ignora o lo
  degrada — comportamento SDK, non nostro).

**Effort — terminali**:
- `TmuxClient.claudeEffort(target, tree)` — stessa tecnica di `claudeModel`
  (`ps -o args= -p <pid>`, regex `--reasoning-effort (\S+)`), best-effort,
  `undefined` se assente.
- `tmux-watcher` salva `effort` sulla sessione in registrazione/refresh, nello
  stesso punto in cui salva `model`.

**Branch**:
- Nuovo modulo `src/git.ts`: `currentBranch(dir): Promise<string | undefined>`
  via `git -C <dir> symbolic-ref --short HEAD` (fallisce pulito se detached,
  non-git, o git assente → `undefined`). `execFile`, timeout breve, niente
  stderr nell'output.
- Calcolato **a runtime di `/diag`** (non persistito): il cwd di una sessione
  può spostarsi tra worktree (il daemon già lo segue con `cwdRefreshMs`), quindi
  il branch letto alla render è la verità corrente. Una chiamata git per
  sessione, `Promise.all`, ogni fallimento silenzioso.

**Resa** (`diagReport` + `DiagSnapshot`):
- `DiagSession` guadagna `model?`, `effort?`, `branch?`.
- Riga sessione: `• <code>id8</code> <titolo> — kind · status · tmux ·
  transcript — <code>model</code> · <code>effort</code> · <code>branch</code>`,
  con `—` quando ignoto.
- `model` già disponibile su `Session` (headless: `session.model ??
  config.defaultModel`; terminali: scoperto dal watcher, eventualmente
  `config.defaultModel` se il processo non ha `--model`).
- Tutto `htmlEscape`d (model/effort/branch provengono da processo/utente).

## 5. Architettura / componenti

| Componente | Responsabilità |
|---|---|
| `src/settings.ts` (nuovo) | tipo `UserSettings`, `loadSettings`, `saveSettings`, validazione |
| `src/config.ts` | fusioni settings > env > default; nuovo campo `defaultEffort`; espone `settingsFile` |
| `src/git.ts` (nuovo) | `currentBranch(dir)` best-effort |
| `src/types.ts` | `Session.effort?`; type `EffortLevel` |
| `src/sessions/manager.ts` | `createHeadless` con `effort`; nessun altro cambiamento di stato |
| `src/sessions/sdk-driver.ts` | passa `effort` a `query()` |
| `src/sessions/tmux-inject.ts` | `claudeEffort` (accanto a `claudeModel`) |
| `src/sessions/tmux-watcher.ts` | salva `effort` sulla sessione (stesso punto di `model`) |
| `bot/telegram.ts` | `parseSettingsCommand`, `formatSettingsReport`, handler `onSettings`; `setMyCommands` (+`settings`, +`diag`); `/help`; `parseNewFlags --effort`; `diagReport` con model/effort/branch |

Flusso dati: `/settings set key value` → `parseSettingsCommand` → validazione →
`saveSettings(settingsFile, …)` → conferma al chiamante → al prossimo avvio
`loadConfig()` legge il file e i componenti nascono con i nuovi valori.
`/diag` → `manager.list()` + `claudeEffort` già sul watcher + `currentBranch`
per sessione → `diagReport`.

## 6. Casi limite / errori

- **`settings.json` corrotto**: preservato come `.corrupt-<ts>`, si riparte da
  vuoto (mai sovrascritto in silenzio — stesso pattern di `state.json`).
- **Valore invalido via `/settings`**: rifiutato con messaggio che elenca i
  valori ammessi (es. `defaultPermissionMode` accetta solo `auto`/`standard`).
- **Chiave ignota via `/settings`**: `parseSettingsCommand` risponde
  `invalid` con la lista delle chiavi note.
- **`/settings` da disarmed**: risponde "🔒 Remote control is off" (gate).
- **Effort non supportato dal modello/provider**: l'SDK lo gestisce (ignora o
  degrada); il daemon non finge di applicarlo.
- **Sessione terminale senza `--reasoning-effort` in `ps`**: `effort` resta
  `undefined` → `—`.
- **Branch non rintracciabile** (non-git, detached, git assente, timeout):
  `currentBranch` → `undefined` → `—`. Nessun errore propagato a `/diag`.
- **`/settings` non riavvia il daemon**: la conferma dice esplicitamente che
  l'effetto è al prossimo riavvio (riavviare da dentro il bot ucciderebbe il
  proprio turno).

## 7. Test

- `test/settings.test.ts` (nuovo): load (mancante/corrotto/preservazione),
  save (atomico), validazione (invalido ignorato, chiavi sconosciute
  scartate).
- `test/config.test.ts`: precedenza settings > env > default per ogni chiave
  curata; `DEFAULT_EFFORT` default e parse; garbage input → lato sicuro.
- `test/telegram.test.ts`: `parseSettingsCommand` (all/show/set/reset/invalid,
  chiave ignota, maiuscole), `formatSettingsReport` (escaping, fonte),
  gate armed/unauthorized, `--effort` in `parseNewFlags`, resa `diagReport`
  con `—` per dati mancanti.
- `test/git.test.ts` (nuovo): branch in repo temporanea, detached → undefined,
  non-git → undefined.
- `claudeEffort`: unit test su `tmux-inject` (stesso pattern di `claudeModel`).

Gate finale: `npm run typecheck && npm test` (CI esegue entrambi).

## 8. Documentazione (stesso commit del codice)

- `README.md`: riga comando `/settings` in Usage; tabella config: `DEFAULT_EFFORT`
  + nota sul layer `settings.json`; riga `/diag` aggiornata (model/effort/branch).
- `AI-GUIDE.md`: riga Setup matrix + lista Command reference (come §4.5).
- `CHANGELOG.md`: voce `## [Unreleased]` dal punto di vista dell'utente
  (`feat(bot): /settings command` e `feat(diag): …`).

## 9. Fuori scope

- Hot-reload dei settaggi a runtime (decisione: al riavvio).
- Modifica di `.env` da Telegram (settings.json è un layer separato, non un
  editor di `.env`).
- `install.sh` per `DEFAULT_EFFORT` (non è una scelta da primo avvio).
- Bottoni inline per /settings (decisione: arg-based).
- Resa del branch per la sola sessione attiva nel header di `/diag`
  (decisione: per sessione).
