# Fix UX Telegram — Design Document

**Data**: 2026-08-05
**Stato**: da revisionare da parte dell'utente

## 1. Problema

Sette problemi segnalati dall'utente usando il bot Telegram, in ordine di segnalazione:

1. **Echo del proprio messaggio** — inviando un testo a una sessione tmux, un istante dopo il bot reinoltra lo stesso testo come se fosse una risposta (rumore).
2. **Permission JSON per le domande a scelta multipla** — quando il modello usa `AskUserQuestion`, oltre alla domanda `❓` appare anche "Permission requested" col JSON grezzo delle opzioni e i bottoni Approve/Reject. Errato.
3. **Comandi slash verso Claude** — i comandi non del bot (es. `/frontend-release`, `/clear`, `/compact`, `/exit`) vengono scartati in silenzio (`onMessage` fa `return` su ogni testo che inizia con `/`).
4. **Interruzione dell'AI** — niente modo di fermare la generazione per le sessioni terminali (l'equivalente di ESC nel CLI).
5. **Storia della sessione** — selezionando una sessione non esce nessun messaggio: non si capisce a che punto è il task.
6. **Eliminazione sessioni** — non esiste modo di rimuovere sessioni headless o terminali dal registro.
7. **Feedback su approve/reject** — il toast transitorio di `answerCallbackQuery` non basta: il messaggio non viene modificato per mostrare la decisione presa.

**Criterio di successo**: tutte e sette le esperienze sopra sono risolte senza introdurre regressioni nello streaming chat, nei permessi o nel disarm.

## 2. Situazione attuale

- `bot/telegram.ts`:
  - `parseCommand` → i comandi sconosciuti producono `{kind:'unknown'}`; `onMessage` scarta ogni testo che inizia con `/` (riga 476).
  - `onCallback` gestisce `perm:approve|deny` e `sess:select`; risponde solo con `answerCallbackQuery` (toast), senza modificare il messaggio.
  - `subscribeBus`:
    - `session.text` → `forwardText` reinoltra anche i messaggi `role:'user'` provenienti dai transcript delle terminali → echo.
    - `session.prompt` → testo `❓` con opzioni numerate, risposta "1"/"2"/"3" via testo. Nessun bottone.
    - `session.permission` → messaggio con JSON grezzo (`permissionMessage`) + Approve/Reject. Non distingue `AskUserQuestion`.
    - `session.tool` per le headless: ogni `tool_use` (incluso `AskUserQuestion`) diventa una bubble `🔧` col JSON dell'input.
- `src/sessions/sdk-driver.ts` — `canUseTool` → `permissionFlow.request` per **ogni** tool, incluso `AskUserQuestion`. Emette `session.tool` per ogni `tool_use`.
- `src/api.ts` — `/api/permission` (hook delle terminali) → `permissionFlow.request` per ogni tool, incluso `AskUserQuestion`.
- `src/sessions/tmux-inject.ts` — solo `injectText` (paste + Enter); nessun invio di tasti (C-c / Escape).
- `src/sessions/transcript.ts` — parser incrementale (tail), nessun lettore di storia retroattivo.
- `src/sessions/manager.ts` — `remove(id)` esiste già; `/stop` chiama `sdk.stop` che abbra solo le headless.

## 3. Design

### Fix 1 — Echo del proprio messaggio

**Registrare i testi iniettati dal bot.** In `routeMessageToSession`, per le sessioni terminali, salvare il testo appena iniettato in `recentInjected: Map<string, { text: string; at: number }[]>` (sessione → ultimi ~5 testi con timestamp). Soglia di corrispondenza: 60s.

**Sopprimere l'echo nel handler di `session.text`.** Quando `e.role === 'user'`, confrontare `e.text` (trim) con i testi recenti della sessione: se c'è una corrispondenza, **non** inviare (l'utente vede già il suo messaggio). I messaggi digitati direttamente nel terminale (non dal bot) non corrispondono → continuano a streammare in chat.

### Fix 2 — Domande a scelta multipla: bottoni, niente JSON

**Auto-allow di `AskUserQuestion`** in entrambi i path, così il permesso JSON non appare mai:
- `sdk-driver.ts` `canUseTool`: se `toolName === 'AskUserQuestion'` → `{ behavior: 'allow' }` subito, senza passare da `permissionFlow`.
- `api.ts` `/api/permission`: se `toolName === 'AskUserQuestion'` → rispondere `allow` subito (l'hook restituisce la decisione al CLI, che mostra il menu interattivo nel pane).

**`session.prompt` come bottoni.** In `bot/telegram.ts`, renderizzare ogni domanda con un bottone inline per opzione:
- intestazione + testo domanda;
- riga di bottoni: un bottone per opzione, callback `q:answer:<promptId>:<index>`;
- la risposta "1"/"2"/"3" via testo resta valida (fallback, già funzionante).

**Headless: emettere `session.prompt` anche lì.** Oggi solo il `transcript-watcher` emette `session.prompt`. In `sdk-driver.ts`, per un blocco `tool_use` con `name === 'AskUserQuestion'`, parsare l'input con `parseAskUserQuestions` ed emettere `session.prompt` (niente bubble `session.tool` col JSON). Il tap su un'opzione per una headless invia l'etichetta scelta come messaggio di testo alla sessione (`runTurn`) — approssimazione best-effort da verificare in implementazione: se il CLI non-interattivo auto-completa il tool, il testo dà comunque al modello la risposta. Fallback documentato: se l'auto-allow in headless si rivelasse problematico, per le sole headless si torna al flusso permesso (ma la notifica mostra la domanda leggibile, non il JSON).

**Ack dei bottoni.** Il tap modifica il messaggio `❓` per mostrare "✓ Risposta: <opzione>" e disabilita i bottoni (stesso pattern del Fix 7).

### Fix 3 — Comandi slash verso Claude

**Passthrough dei comandi sconosciuti.** In `onMessage`, al posto di `if (text.startsWith('/')) return;`, inoltrare alla sessione attiva il testo **verbo e con lo slash iniziale** tramite `routeMessageToSession`. I comandi registrati del bot (`/rc`, `/sessions`, `/view`, `/new`, `/stop`, `/status`, `/attach`, `/help`, `/start`) continuano a essere gestiti da grammy e non arrivano qui. Effetto:
- sessioni terminali: `/clear`, `/compact`, `/exit`, `/frontend-release` vengono iniettati nel pane → il CLI li elabora;
- headless: arrivano come prompt al modello.

Nessun wrapper aggiuntivo (`/run`) per ora — YAGNI. Il gate `armed` resta (già presente in `onMessage`).

### Fix 4 — Interruzione (equivalente di ESC)

**Estendere `/stop`** per coprire le sessioni terminali:
- headless: abort via `AbortController` (già funzionante, invariato);
- terminali: nuovo metodo `TmuxClient.sendKeys(target, keys)` (tmux `send-keys -t <id> '<keys>'`) e invio di **`C-c`** al pane. Claude Code lo interpreta come interruzione della generazione corrente (equivalente di ESC).

`onStop` aggiorna la reply per dire cosa è stato interrotto (e per le terminali, che è stato mandato Ctrl+C al pane). Se non c'è sessione attiva, la risposta resta informativa.

### Fix 5 — Storia della sessione su selezione

**Lettore retroattivo del transcript.** In `src/sessions/transcript.ts`, nuova funzione `readRecentMessages(file: string, max: number = 10): TranscriptTextEvent[]` che parsa il JSONL dall'inizio (senza dedup incrementale), filtra i blocchi testo `user`/`assistant` (salta i tool), e restituisce gli ultimi `max`.

**Risoluzione del file:**
- terminali: `s.transcriptFile` (già tracciato dal watcher);
- headless: nuova risoluzione per `claudeSessionId` nel project dir (`~/.claude/projects/<munged>/<sessionId>.jsonl`), fallback al più recente per il project dir — riusa la logica di `resolveTranscriptDir` + `newestTranscriptFile`. Il fallback se non c'è transcript: buffer in-memory degli ultimi eventi `session.text` visti dal bus (se la sessione è stata tracciata in questo run del daemon).

**Trigger:**
- selezione da `/sessions` (callback `sess:select`) → dopo aver impostato `activeSessionId`, inviare un blocco unico con gli ultimi ~10 messaggi (rendered con `mdToHtml`, troncato a ~3000 caratteri);
- nuovo comando `/history [id]` per richiederlo on-demand (default: sessione attiva).

### Fix 6 — Eliminazione sessioni

**Comando `/delete [id]`** (default: sessione attiva):
- headless: `permissionFlow.cancelAllForSession(id)` + `sdk.stop(id)` (abort turno) poi `manager.remove(id)`;
- terminali: solo `manager.remove(id)` (il pane tmux continua a girare: si perde solo il tracking);
- se si elimina la sessione attiva, azzerare `activeSessionId`.

**Bottone 🗑 per riga in `/sessions`:** accanto al bottone di selezione, `sess:del:<id>`.

**Conferma inline:** sia `/delete` sia il bottone 🗑 aprono "Delete <titolo>? [✓ Yes / ✗ No]" (`sess:delconf:<id>` → yes/no). Yes → elimina + conferma; No → cancella. (Deleting a headless perde il pointer di resume → la conferma è il default; cambiabile su richiesta.)

### Fix 7 — Feedback su approve/reject

**Edit del messaggio di permesso.** In `onCallback`, per `perm:approve`/`perm:deny`, dopo la decisione:
- `ctx.editMessageText` con lo stesso testo ma intestazione aggiornata e senza bottoni, es. `✅ Approved — <tool>` / `❌ Rejected — <tool>` (o, se già risolto, "Already resolved");
- `answerCallbackQuery` resta per il feedback immediato.

**Stesso pattern per:** bottoni delle domande (Fix 2) e, ove applicabile, selezione sessione. Necessario `parse_mode: 'HTML'` coerente col messaggio originale; edit idempotente se la risposta è già stata data (il `permissionFlow.approve/deny` ritorna `false` → non editare, solo toast).

## 4. Modifiche ai file

| File | Modifica |
|------|----------|
| `bot/telegram.ts` | Fix 1 (registro iniettati + soppressione echo), Fix 2 (bottoni domande + ack), Fix 3 (passthrough slash), Fix 4 (`/stop` terminali), Fix 5 (storia su selezione + `/history`), Fix 6 (`/delete` + 🗑 + conferma), Fix 7 (edit del messaggio). Nuovi callback `q:answer`, `sess:del`, `sess:delconf`. |
| `src/sessions/sdk-driver.ts` | Auto-allow `AskUserQuestion` in `canUseTool`; emettere `session.prompt` al posto di `session.tool` per `AskUserQuestion`. |
| `src/api.ts` | `/api/permission`: rispondere `allow` per `AskUserQuestion`. |
| `src/sessions/tmux-inject.ts` | Nuovo metodo `sendKeys(target, keys)`. |
| `src/sessions/transcript.ts` | Nuova `readRecentMessages(file, max)` (e supporto risoluzione per headless, se serve). |
| `test/` | Test per: soppressione echo, auto-allow `AskUserQuestion`, bottoni domande + ack, passthrough slash, `/stop` terminale (mock `sendKeys`), `/delete` + conferma, edit approva/rifiuta. |

## 5. Gestione errori e casi limite

- **Echo**: testo iniettato che non combacia (es. CLI che normalizza spazi) → non soppresso, ma nessun danno (è comunque il messaggio dell'utente). La soglia di 60s evita di sopprimere un messaggio identico inviato molto dopo.
- **AskUserQuestion auto-allow** in headless: se il turno si blocca (tool non risolvibile senza UI), il fix 4 (`/stop`) resta l'uscita di emergenza; fallback documentato nel Fix 2.
- **Delete di sessione attiva**: `activeSessionId` azzerato; lo streaming smette di puntare a una sessione sparita.
- **Edit del messaggio**: se il messaggio è stato già editato/risolto, `editMessageText` può fallire → `catch` silenzioso, toast comunque.
- **`/history` senza transcript**: messaggio esplicativo ("no transcript available for this session") invece di errore.
- **Passthrough slash su sessione non tmux (terminal senza pane)**: stesso avviso di oggi ("can't be injected").

## 6. Cose da verificare in implementazione

1. Comportamento del CLI non-interattivo su `AskUserQuestion` auto-allowato (headless): auto-completa, fallisce, o resta in attesa? Determina se il tap-opzione per headless deve inviare testo o richiedere un altro approccio.
2. Formato dei transcript headless (nome file `<sessionId>.jsonl` sotto `~/.claude/projects`) per la risoluzione del Fix 5.
3. `send-keys C-c` su una sessione tmux senza un turno attivo: innocuo (linea shell).

## 7. Fuori scope

- Supporto nativo `streamInput`/`streaming` dell'SDK per rispondere davvero al tool_use pendente nelle headless (si userà il reply testuale best-effort).
- UI della domanda "con risposta libera" oltre ai bottoni (resta la risposta via testo).
- Wrapper esplicito `/run` (si può aggiungere dopo se il passthrough non basta).
- Rotazione log, miglioramenti vari non legati ai 7 fix.
