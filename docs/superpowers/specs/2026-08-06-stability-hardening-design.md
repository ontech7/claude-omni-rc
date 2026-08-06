# Stabilizzazione del remote control — Design Document

**Data**: 2026-08-06
**Stato**: da revisionare da parte dell'utente

## 1. Problema

Il daemon non è affidabile come remote control da telefono. Tre sintomi riportati dall'utente (2026-08-05/06):

1. **"Si è impallato"** — il daemon è crashato. Causa confermata nei log (`~/.ollama-rc/logs/daemon.err.log`): un messaggio inoltrato a una sessione terminale → `tmux.injectText` lancia ("no server running") → l'errore risale nel middleware di grammy → **nessun `bot.catch`** → grammy ferma il bot → `bot.start()` rigetta → `process.exit(1)`. Un singolo errore in un handler uccide l'intero daemon.
2. **`/stop` non funziona benissimo** — risponde sempre "Stop requested" anche quando non c'è nulla da fermare (nessun feedback reale); per le terminali invia C-c anche da idle e dichiara "generation interrupted" a sproposito.
3. **Scelte multiple troncate** — le opzioni dei bottoni sono troncate a 24 caratteri (`telegram.ts:778`) e il testo del messaggio mostra solo il titolo della domanda, mai le opzioni: il fallback "rispondi con il numero" è inutilizzabile perché i numeri non sono visibili.

Obiettivi trasversali (dall'utente): **non deve bloccarsi**, **non deve dare informazioni parziali**, deve funzionare bene come remote control dal telefono.

**Criterio di successo**: nessun errore in un handler (tmux giù, API Telegram lenta, markdown sbilanciato, runTurn che rifiuta) può più far morire il daemon o far sparire un messaggio; `/stop` risponde con lo stato reale; le scelte multiple mostrano le opzioni per intero.

## 2. Situazione attuale

- `bot/telegram.ts`:
  - Nessun `bot.catch` → grammy si ferma su errore di middleware non gestito.
  - `routeMessageToSession` fa `await injectText` senza try/catch (linee 653-670) — il vettore del crash.
  - `void this.deps.sdk.runTurn(...)` senza `.catch` (linee 450, 577, 661): una promise rifiutata non gestita **uccide il processo in Node 22 per default** (secondo vettore di crash, latente: race sul busy-guard in `answerPrompt`).
  - `.catch(() => {})` silenziosi su send/edit → errori senza log.
  - `/stop` (453-471): non usa il ritorno reale di `sdk.stop()`, invia C-c a prescindere.
  - `promptMessage` (107-114): solo titolo, niente opzioni; bottoni troncati a 24 char.
  - `mdToHtml` (89-99): le regex di formattazione girano anche dentro `<pre>`/`<code>` (markup del modello corrotto nei blocchi di codice), nesting `***x***` non gestito, e casi limite possono produrre HTML sbilanciato che Telegram rigetta → messaggio perso in silenzio (`.catch(()=>{})`).
  - `renderHistory` (124-127): `body.slice(0, maxChars)` taglia a metà messaggio.
  - `activeSessionId` non persistito → dopo un riavvio lo streaming si azzera.
  - Nessun timeout sulle chiamate API Telegram → un handler che aspetta una chiamata appesa blocca la coda sequenziale degli update (il bot sembra morto).
- `src/sessions/tmux-inject.ts` — `createExec` senza timeout: un comando tmux appeso stallerebbe l'handler.
- `src/sessions/sdk-driver.ts` — l'abort di `/stop` durante `modelContext()` è onorato solo *dopo* che il fetch risolve.
- `src/ollama.ts` — `modelContext`/`hasVision`/`listModels` senza timeout (best-effort ma non limitati).
- `src/state.ts` / `src/sessions/manager.ts` — nessun campo `activeSessionId`.

## 3. Design

### 3.1 Error containment — il daemon non muore più

**`bot.catch` globale** (in `TelegramBot`): registra `this.bot.catch(err => console.error('ollama-rc bot error:', err.error ?? err))`. grammy non si ferma mai più su un errore di middleware.

**Wrapper `safe()` per gli handler**: `private safe(ctx, label, fn)` esegue `fn` e su eccezione fa `console.error(label, err)` + reply "❌ Something went wrong (check daemon log)". Ogni handler registrato (`bot.command`, `bot.on`) passa da `safe`. Doppia rete di sicurezza sopra i try/catch interni già presenti.

**`routeMessageToSession`**: try/catch attorno a `injectText` con errore amichevole:
`❌ Can't inject into <code><target></code>: <msg>. Is tmux running?` — mai più un throw che risale.

**Helper `track(promise, label)`**: aggiunge `.catch(e => console.error(...))` a ogni fire-and-forget, inclusi i tre `void runTurn(...)` e le push dei tool burst. Rete finale nel daemon: `process.on('unhandledRejection', ...)` che logga (non crash).

**Niente più `.catch(() => {})` silenziosi**: convertiti in `.catch(e => console.error(label, e))` (helper `logCatch(label)`). Le edit idempotenti che falliscono perché "già risolte" restano catch-e-ignora ma loggate.

### 3.2 Timeout — non si blocca mai

- **grammy**: `new Bot(token, { client: { timeoutSeconds: 35 } })`. Le `getUpdates` long-poll usano 30s server-side (grammy `bot.js`), quindi 35s non le taglia; ogni altra chiamata API è limitata.
- **tmux**: `createExec` accetta `timeoutMs` (default 10s); allo scadere uccide il child e rifiuta con `tmux timed out`. Applicato a tutti i comandi `TmuxClient`.
- **Ollama**: `fetch` con `AbortSignal.timeout(10s)` in `modelContext`, `hasVision`, `listModels` (best-effort ma limitati).
- **Download Telegram** (`downloadTelegramFile`): `AbortSignal.timeout(30s)`.

### 3.3 `/stop` — feedback reale, niente razze

- **Headless**: `permissionFlow.cancelAllForSession(s.id)` + `const aborted = sdk.stop(s.id)`. Risposta basata sul risultato reale:
  - aborted → `🛑 Turn aborted for session <id8>.`
  - altrimenti → `No turn is running for session <id8> (status: <status>).`
- **Terminale**: C-c al pane con try/catch (già presente); reply accurata (`Ctrl+C sent to <target>` o `❌ <err>`). Se tmux giù → errore amichevole, non generico.
- **Razza**: in `sdk-driver.runTurn`, check `ac.signal.aborted` anche **prima** di `modelContext` (oltre a quello già dopo la fetch). Il timeout 10s su `modelContext` (3.2) restringe ulteriormente la finestra.
- Logica di decisione della risposta estratta in un **helper puro** `stopReply(kind, hasTurn, status)` testabile.

### 3.4 Scelte multiple — testo completo, mai troncato

- **`promptMessage` v2**: elenco numerato delle opzioni **per intero** nel testo del messaggio, con description opzionale:
  ```
  ❓ <b>Header: domanda</b>
   1. Label — description
   2. Label
  ```
- **Bottoni**: uno per opzione con etichetta corta (≤ 40 char, troncata con `…`); il tap risponde con la **label completa** (invariato). Se le opzioni totali superano un cap (`12`), niente bottoni: resta l'elenco numerato (il reply col numero funziona perché i numeri sono ora visibili). L'hint si adatta ("Tocca un'opzione o rispondi con il numero" / "Rispondi con il numero").
- **Ack**: il messaggio editato mantiene `pending.text` (l'elenco completo) + `✅ Risposta: <label completa>` — mai informazione persa.
- `multiSelect: true` resta non gestito (tap = una label): fuori scope.

### 3.5 `mdToHtml` v2 — correzione del markup, niente messaggi persi

Nuovo renderer con correzione attiva (scelta dell'utente):

1. **Protezione del codice**: i blocchi ```` ```…``` ```` e il codice inline `` `…` `` vengono estratti con placeholder (il contenuto già html-escaped) e **non vengono toccati** dalle regex di formattazione (corregge il bug odierno per cui `**`/`#` dentro un `<pre>` vengono convertiti).
2. **Nesting**: `***x***` → `<b><i>x</i></b>`; `**x**` → `<b>x</b>`; `*x*` → `<i>x</i>`, con ordine che evita di rompere coppie annidate.
3. **Balance pass finale**: scansione dell'output, conteggio dei tag aperti (`<b>/<i>/<code>/<pre>/<a>`), auto-chiusura di quelli rimasti aperti a fine input. Il risultato è sempre HTML ben formato accettato da Telegram → **nessun messaggio mai scartato**.
4. Headings/liste/link invariati (e ora protetti dentro i blocchi di codice grazie ai placeholder).

Il tutto come helper puri (`mdToHtml`, `balanceHtml`) con test dedicati.

### 3.6 `renderHistory` — niente tagli a metà

- Cap per **messaggi interi**: si includono i messaggi più recenti finché la somma non supera `maxChars` (default 3800); i più vecchi vengono scartati, mai un messaggio spezzato.
- Un singolo messaggio più lungo del cap viene troncato a fine parola con marcatore esplicito `… (truncated)`.
- `renderHistory` resta puro e testabile.

### 3.7 Persistenza della selezione

- `StateFile` acquisisce `activeSessionId?: string` (default `undefined`).
- `SessionManager`: metodi `setActive(id)` / `getActive()` che persistono al cambio; alla rimozione di una sessione, se era attiva la azzerano.
- Il bot legge/scrive `activeSessionId` via manager (oggi campo privato). Allo start, `TelegramBot` ripristina la selezione da `manager.getActive()` → dopo un crash/riavvio lo streaming riparte sulla sessione che era selezionata.

## 4. Flusso dati (invariato)

`Telegram ↔ bot ↔ bus ↔ sessioni (SDK / tmux) ↔ Ollama`. Le modifiche rafforzano i confini di errore e i timeout, non cambiano il routing.

## 5. File toccati

| File | Modifica |
|------|----------|
| `bot/telegram.ts` | `bot.catch`, `safe()`, `track()`, `logCatch()`, try/catch in `routeMessageToSession`, `/stop` con feedback reale, `promptMessage` v2 + bottoni, `mdToHtml` v2 + `balanceHtml`, `renderHistory` v2, `activeSessionId` via manager, `client.timeoutSeconds`. |
| `src/sessions/manager.ts` | `setActive`/`getActive` + persistenza; azzeramento su remove. |
| `src/state.ts` | `StateFile.activeSessionId`. |
| `src/daemon.ts` | guardia `unhandledRejection`; ripristino selezione attiva allo start. |
| `src/sessions/tmux-inject.ts` | timeout su `createExec`. |
| `src/sessions/sdk-driver.ts` | check abort prima di `modelContext`. |
| `src/ollama.ts` | timeout sui fetch. |
| `test/` | test per i nuovi helper puri e i timeout (vedi §7). |

## 6. Errori e casi limite

| Caso | Comportamento |
|---|---|
| tmux giù / pane sparito durante un messaggio | reply amichevole, nessun crash, log |
| API Telegram appesa | timeout 35s → errore loggato, la coda update procede |
| Markdown del modello sbilanciato | balance pass chiude i tag → HTML valido, messaggio sempre consegnato |
| `runTurn` che rifiuta (race busy-guard) | `track()` logga; guardia `unhandledRejection` in daemon |
| `/stop` senza turno in corso | reply con lo stato reale della sessione |
| MC con troppe opzioni | solo elenco numerato (mai troncato) |
| Sessione attiva eliminata | `activeSessionId` azzerato |
| Riavvio daemon | selezione attiva ripristinata; aggregator tool in-memory persi (irrilevante) |
| Comando tmux che non risponde | timeout 10s → errore amichevole |

## 7. Test

1. **`mdToHtml`**: `**bold**`/`*it*`/`***both***`; `**non chiuso` → `<b>non chiuso</b>` (auto-chiuso); blocco di codice con `**`/`#`/`*` intatto; `balanceHtml` su output arbitrario → sempre bilanciato.
2. **`promptMessage`**: opzioni numerate con description; escaping HTML.
3. **`renderHistory`**: cap per messaggi interi (mai metà); marcatore di troncamento su messaggio singolo lungo.
4. **`stopReply`**: headless con/senza turno, terminale, status riportati correttamente.
5. **`createExec` timeout**: fake child che non esce → rifiuta dopo `timeoutMs`.
6. **state**: round-trip `activeSessionId` (load/save), azzeramento su remove.
7. `npm run typecheck && npm test` verdi.
8. Checklist manuale (daemon live): messaggio a terminale con tmux giù → errore amichevole, daemon vivo; `/stop` su sessione idle → stato reale; domanda MC → opzioni complete + bottoni; reply col numero; messaggio con markdown sbilanciato → consegnato; riavvio daemon → sessione attiva preservata.

## 8. Fuori scope

- Risposta multi-select alle domande (`multiSelect: true`) — un tap = una label.
- Retry/backoff esplicito su rate-limit Telegram (il timeout basta per ora).
- Modulo di logging strutturato (basta `console.error` → già catturato da launchd in `daemon.err.log`).
- App dedicata (Fase 2) e relative decisioni di UX.
