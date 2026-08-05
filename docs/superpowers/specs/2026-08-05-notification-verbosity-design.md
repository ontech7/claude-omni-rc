# Notifiche meno verbose — Design Document

**Data**: 2026-08-05
**Stato**: da revisionare da parte dell'utente

## 1. Problema

Il bot Telegram notifica ogni cambio di stato della sessione terminale attiva e ogni uso di tool, generando rumore. L'utente vuole meno verbosità in chat:

1. **Rimuovere le notifiche di stato** ridondanti: `🤖 Claude is working…` e `⚠️ Claude is waiting for your response…`.
2. **Aggregare le notifiche tool in un'unica bubble per raffica**: il primo `tool_use` crea il messaggio, i successivi lo **modificano** (append). Un testo/domanda apre una bubble nuova; la raffica successiva di tool apre una nuova bubble e ricomincia a modificare quella.
3. **Notificare errori seri** per le sessioni terminali (oggi solo le headless emettono `session.error`).

**Criterio di successo**: in una sessione lunga, il canale mostra poche bubble di lavoro (una per raffica di tool + una per risposta testuale) invece di una notifica per ogni evento.

## 2. Situazione attuale

- `bot/telegram.ts` (`subscribeBus`):
  - `session.updated` → notifica `awaiting-input` ("waiting for your response") e `running` ("Claude is working…").
  - `session.tool` (`kind: tool_use`, con input) → una notifica nuova per ogni tool.
  - `session.prompt` (domande AskUserQuestion), `session.permission`, `session.error` → notifiche event-driven già corrette.
- `TranscriptWatcher` (`src/sessions/transcript-watcher.ts`) deduce lo stato dal transcript e lo scrive sul manager. Lo status `awaiting-input` viene impostato in **due casi distinti**:
  1. il turno è finito normalmente (`stop_reason: "end_turn"` o `system`/`turn_duration`) — la conversazione è solo finita, Claude non chiede nulla;
  2. Claude ha aperto un menu a scelta multipla (`AskUserQuestion`) — che genera **anche** `session.prompt` (le domande formattate).
  
  La notifica "waiting for your response" scatta in entrambi i casi → falsa nel caso 1 (quello osservato dall'utente), ridondante nel caso 2.
- `session.error` è emesso **solo** dall'`SdkDriver` (headless). Le sessioni terminali non emettono mai errori.
- Segnali di errore rilevabili nel transcript (verificati sul disco, v2.1.222):
  - `stop_reason: "max_tokens"` — vero errore, raro (1 occorrenza nella cronologia);
  - `tool_result` con `is_error: true` — comando/azione fallito (19 occorrenze), rumoroso;
  - nessun blocco `result` a livello messaggio, nessun subtype `error` in questa versione.

## 3. Decisioni chiave

1. **Niente notifiche di stato**: rimossi il handler `session.updated` e la mappa `lastNotified`. "Waiting for your response" era ridondante con `session.prompt` (che manda già le domande) e falsa per `end_turn`.
2. **Tool aggregati per raffica (Approccio A — basato sul contenuto)**: l'append alla bubble aperta avviene finché l'ultimo evento emesso era un `tool_use`; qualsiasi `session.text` (entrambi i ruoli), `session.prompt` o `session.permission` chiude la raffica. Niente finestra temporale: un burst può durare quanto serve, ma non fonde turni separati.
3. **Errori seri per le terminali**: `stop_reason: "max_tokens"` → nuovo evento `error` dal parser → `session.error` dal watcher → notifica `❌` (handler già esistente nel bot). **Niente** notifiche per i comandi falliti (`is_error: true`): troppo rumorose, Claude di solito recupera da solo.

## 4. Architettura

### 4.1 `ToolBurstAggregator` (nuovo, in `bot/telegram.ts`)

Classe piccola e testabile (come `EditThrottler`), con i sink iniettati:

```ts
export interface ToolBurstSink {
  edit(messageId: number, text: string): Promise<boolean>;  // false = non riuscito
  send(text: string): Promise<number | undefined>;          // → message_id
}

export class ToolBurstAggregator {
  private open?: { messageId: number; text: string; at: number };
  private lastWasTool = false;

  constructor(private sink: ToolBurstSink, private maxLen = 3800) {}

  async push(line: string): Promise<void> {
    const open = this.open;
    if (this.lastWasTool && open) {
      const next = `${open.text}\n${line}`;
      if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
        open.text = next;
        open.at = Date.now();
        return;
      }
    }
    const id = await this.sink.send(line);
    if (id !== undefined) this.open = { messageId: id, text: line, at: Date.now() };
    this.lastWasTool = true;
  }

  close(): void {
    this.open = undefined;
    this.lastWasTool = false;
  }
}
```

- `push` su ogni `tool_use` (con input); `close` su `session.text` (user e assistant), `session.prompt`, `session.permission`.
- Cap a `maxLen`: se l'append sfora, la raffica corrente resta com'è e se ne apre una nuova.
- Il bot fornisce il sink usando l'`EditThrottler` esistente (condiviso con le text bubble) e `bot.api.sendMessage`/`editMessageText`. Il `send` ritorna `message.message_id`.

### 4.2 Bot (`bot/telegram.ts`)

- **Rimosso** `bus.on('session.updated', ...)` e `lastNotified`.
- Nuova mappa `toolBursts = new Map<string, ToolBurstAggregator>()` (una per sessione).
- `bus.on('session.tool')`: solo `tool_use` con input → `agg(sessionId).push(line)` dove `line = 🔧 <code>name</code> — <pre>input</pre>` (formato invariato).
- `session.text` / `session.prompt` / `session.permission` → `agg(sessionId).close()`.

### 4.3 Rilevazione errori terminali

`src/sessions/transcript.ts`:
- Nuovo membro dell'unione `TranscriptEvent`:
  ```ts
  interface TranscriptErrorEvent { type: 'error'; message: string }
  ```
- In `TranscriptParser.consumeLine`, blocco assistant: se `stop_reason === 'max_tokens'` →
  - `this.state = 'awaiting'` (Claude si è fermato; oggi diverrebbe erroneamente `working` perché `max_tokens` ≠ `end_turn`);
  - emette `{ type: 'error', message: 'Claude hit the output limit (max_tokens). Ask it to continue.' }`, dedup per id messaggio (come `seenText`/`seenTool`).

`src/sessions/transcript-watcher.ts`:
- In `emit`, nuovo caso `ev.type === 'error'` → `manager.touch(s.id)` + `bus.emit({ type: 'session.error', sessionId: s.id, message: ev.message })`. **Niente** `setStatus('error')`: lo stato resta gestito da `applyState` (→ `awaiting-input`), la prossima user line riporta a `working`.

## 5. Flusso dati

```
raffica tool:  tool_use → session.tool → ToolBurstAggregator.push
               → sendMessage (primo) / editMessageText (successivi)
chiusura:      session.text/.prompt/.permission → ToolBurstAggregator.close
               → prossimo tool_use apre una bubble nuova

errore term.:  assistant stop_reason=max_tokens → parser event 'error'
               → TranscriptWatcher → session.error → bot notifica ❌
```

## 6. Errori e casi limite

- **Edit fallito** (rate limit, messaggio cancellato): `sink.edit` ritorna `false` → fallback a `send` (bubble nuova). L'`EditThrottler` ritorna `undefined` in errore → trattato come `false`.
- **Lunghezza > `maxLen`**: bubble nuova.
- **Bot riavviato**: gli aggregator sono in-memory; la raffica aperta si perde e il prossimo `tool_use` apre una bubble nuova (nessun danno).
- **`max_tokens` ripetuto** per lo stesso id messaggio: dedupe, una sola notifica.
- **Comandi falliti** (`tool_result` con `is_error`): nessuna notifica (scelta "solo errori seri"). Il messaggio `🔧 …` del tool che ha fallito può comunque comparire nella bubble aggregata (è un `tool_use`).
- **Stato**: `max_tokens` → `awaiting-input` (recoverable); una user line successiva → `working`.

## 7. File toccati

- `bot/telegram.ts` — `ToolBurstAggregator` + sink; rimozione handler stato e `lastNotified`; `close` nei handler testuali; mappa `toolBursts`.
- `src/sessions/transcript.ts` — `TranscriptErrorEvent` + rilevazione `max_tokens` + dedupe + stato `awaiting`.
- `src/sessions/transcript-watcher.ts` — inoltro `error` → `session.error`.
- `test/transcript.test.ts` — test parser per `max_tokens`.
- Test per `ToolBurstAggregator` (in `test/telegram.test.ts` o file dedicato).
- Documentazione: aggiornare `README.md` (riga ~154, la bubble "waiting for your response") e `CHANGELOG.md` a implementazione fatta.

## 8. Test

1. **TranscriptParser**:
   - assistant line con `stop_reason: "max_tokens"` → `consumeLine` ritorna `[{ type: 'error', message: … }]` e `state === 'awaiting'`;
   - la stessa riga richiamata di nuovo → `[]` (dedupe);
   - righe `end_turn`/`tool_use`/user line: nessun evento `error` (non regressione).
2. **ToolBurstAggregator** (mock dei sink):
   - prima `push` → `send`; seconda `push` (ultimo evento tool) → `edit` con testo concatenato;
   - `close()` poi `push` → `send` di nuovo (bubble nuova);
   - append oltre `maxLen` → `send` (bubble nuova), contenuto precedente intatto;
   - `edit` che ritorna `false` → fallback a `send`.
3. Nessuna modifica ai test esistenti del bot (il handler di stato non è coperto dai test attuali).
