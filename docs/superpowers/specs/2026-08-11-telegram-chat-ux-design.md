# UX/UI della chat Telegram — Design Document

**Data**: 2026-08-11
**Branch**: `feat/telegram-ux`
**Stato**: da revisionare da parte dell'utente

## 1. Problema

Usando il bot, la chat è difficile da leggere su tre fronti:

1. **Le tool call sono illeggibili.** Compaiono frammenti grezzi come
   `⚙️ cd /Users/ontech7/Documents/PersonalProjects/... && python3 - <<'PY'` invece
   di dire *cosa sta facendo* il modello.
2. **Non si distingue cosa sta usando il modello.** Una Skill, un tool MCP, un
   subagent e una `Read` hanno tutti lo stesso aspetto: `⚙️` più il primo valore
   stringa dell'input.
3. **I testi si leggono male.** Il markdown del modello viene reso solo
   parzialmente; blocchi di codice senza linguaggio, tabelle sfasciate, citazioni
   perse, e messaggi lunghi spezzati a metà frase.
4. **L'attività dei subagent si mescola a quella della sessione principale.** In
   una UI con più pannelli sarebbe un albero; su Telegram, che ha una chat sola e
   lineare, diventa un flusso indistinguibile. L'utente non vuole nascondere
   quell'output, vuole **decidere** se guardarlo: di default gli basta sapere che
   un agent sta lavorando e quando ha finito.

A questi si aggiunge un problema di rumore: **ogni** bolla tool fa vibrare il
telefono, e ogni URL citato dal modello apre un'anteprima gigante.

**Criterio di successo**: leggendo la chat si capisce cosa sta facendo il modello
senza dover interpretare path assoluti o JSON; Skill, MCP e subagent sono
riconoscibili a colpo d'occhio; i fallimenti di una tool sono visibili; il
telefono notifica solo quando serve una persona.

## 2. Situazione attuale

- `bot/telegram.ts` (2512 righe) mescola trasporto e presentazione.
- `summarizeTool()` (riga 681) è il formatter di fallback:
  - `bash` → `⚙️ {command}` — **il comando nudo**. È l'origine del problema 1.
  - nessun caso per `Skill`, per i tool MCP (`mcp__server__tool`), per `Workflow`,
    per `SlashCommand`; cadono tutti nel ramo generico `⚙️ {toolName} — {primo valore stringa}`.
  - `read`/`write`/`edit` stampano il **path assoluto** non accorciato.
  - `todowrite` → `⚙️ Updates the task list`, senza dire quale.
- Sopra il fallback c'è `llmSummarize()` (riga 1284): una chiamata a Ollama per
  **ogni** tool call, timeout 5s, che genera la frase in linguaggio naturale. Se
  Ollama è lento o giù si ricade su `summarizeTool()`. È lento, non riproducibile
  e richiede un modello locale.
- `session.tool` handler (riga 2445): `if (e.kind === 'tool_use')`. I
  **`tool_result` sono parsati dal transcript ma buttati via dal bot** → un
  comando fallito è indistinguibile da uno riuscito.
- `mdToHtml()` (riga 157) copre: ` ``` ` → `<pre>`, `` ` `` → `<code>`, `**`/`*`,
  heading → `<b>`, `- ` → `• `, link. Non copre: linguaggio dei blocchi di codice,
  `>` citazioni, `~~`, liste ordinate/annidate, tabelle, `---`.
- `balanceHtml()` e `splitHtmlMessage()` conoscono solo i tag `b|i|code|pre|a`.
- Nessun uso di `disable_notification` né di `link_preview_options`.
  (`setMyCommands` è arrivato con la 0.4.0, dopo la stesura di questo spec.)
- `src/sessions/sdk-driver.ts` (righe 109-161) **ignora `parent_tool_use_id`**.
  L'SDK marca con quel campo ogni messaggio che proviene da un subagent, e per
  default emette già i blocchi `tool_use`/`tool_result` dei subagent
  (`forwardSubagentText: false` limita solo *testo* e *thinking*). Il driver li
  rigira sul bus identici a quelli della sessione principale: **è questa la causa
  del mescolamento**, non un problema di rendering.
- Il driver ignora anche i messaggi `system` di tipo `task_started`,
  `task_progress`, `task_updated`, che l'SDK emette già con tutto quello che
  serve (vedi 3.6).

## 3. Design

### 3.1 Nuovo modulo `bot/render.ts`

Tutta la presentazione (funzioni **pure**, zero I/O) esce da `telegram.ts`:
`htmlEscape`, `mdToHtml`, `balanceHtml`, `splitHtmlMessage`, più le nuove
`describeTool`, `shortenPath`, `renderToolLine`.

Motivo: `telegram.ts` è troppo grande per essere ragionato tutto insieme, e la
presentazione è la parte che si testa meglio in isolamento — nessun mock, solo
input → stringa. `telegram.ts` resta il trasporto (bus, invii, throttling, flow).

I test esistenti che importano queste funzioni da `bot/telegram.ts` puntano al
modulo nuovo.

### 3.2 `describeTool()` — catalogo deterministico

Sostituisce `summarizeTool()`. Firma:

```ts
export interface ToolLine {
  icon: string;      // '📖'
  label: string;     // 'Read'        — sempre in inglese, etichetta fissa
  target?: string;   // 'bot/telegram.ts' — reso in <code>
  detail?: string;   // testo libero, nella lingua del modello
}
export function describeTool(toolName: string, input: Record<string, unknown>, projectDir?: string): ToolLine
export function renderToolLine(line: ToolLine): string
```

`renderToolLine` compone sempre nella stessa forma, saltando i pezzi assenti:

```
{icon} <b>{label}</b> · <code>{target}</code> — {detail}
```

`label` e `detail` passano da `htmlEscape`; `target` pure, dentro `<code>`.
`detail` viene troncato a 100 caratteri su confine di parola. Per `Bash` il
comando va su una seconda riga in `<code>`, troncato a 200 caratteri.

Catalogo:

| Tool | icon | label | target | detail |
|---|---|---|---|---|
| `Bash` | ⚡ | Bash | — | **`input.description`** (vedi sotto), comando in `<code>` sotto |
| `Read` | 📖 | Read | path accorciato | `lines N–M` se `offset`/`limit` |
| `Write` | 📝 | Write | path accorciato | — |
| `Edit` | ✏️ | Edit | path accorciato | `replace_all` se true |
| `NotebookEdit` | 📓 | Notebook | path accorciato | — |
| `Glob` | 🔍 | Glob | `pattern` | `in {path}` |
| `Grep` | 🔎 | Grep | `pattern` | `in {path}` |
| `WebFetch` | 🌐 | Fetch | hostname dell'URL | inizio del `prompt` |
| `WebSearch` | 🔎 | Search | `query` | — |
| `Task` | 🤖 | Agent | `subagent_type` | `description` |
| `Skill` | 🧩 | Skill | `skill` | `args` |
| `mcp__<srv>__<tool>` | 🔌 | MCP `<srv>` | `<tool>` | primo argomento significativo |
| `TodoWrite` | 📋 | Todo | `{done}/{tot}` | contenuto della voce `in_progress` |
| `ExitPlanMode` | 📋 | Plan | — | — |
| `SlashCommand` | ⌨️ | Command | `command` | — |
| `Workflow` | 🎛 | Workflow | `name` | `description` |
| ignoto | ⚙️ | `{toolName}` | — | primo valore stringa |

**Il campo `description` di Bash.** Verificato sui transcript reali: ogni
`tool_use` di `Bash` emesso dal CLI porta un campo `description` scritto dal
modello (es. `"List assets and recent commit stats"`). Il codice attuale lo
ignora del tutto a favore di `command`. Usarlo come etichetta primaria è la
singola correzione che risolve il problema segnalato. Se `description` manca
(tool call malformata, o un client diverso), si ricade sul comando troncato.

**`shortenPath(path, projectDir)`**: toglie il prefisso `projectDir` e poi
sostituisce `$HOME` con `~`. Se il path resta oltre ~50 caratteri, elide i
segmenti centrali (`src/…/telegram.ts`). Un path fuori dal progetto e fuori da
home resta assoluto ma elided. È questa funzione, non il catalogo, a eliminare la
maggior parte dell'illeggibilità.

**Parsing MCP**: `mcp__context7__query-docs` → server `context7`, tool
`query-docs`. Il nome del server può contenere `_`, quindi lo split è sul primo
`__` dopo il prefisso e sull'**ultimo** `__` per il tool. Il "primo argomento
significativo" per il `detail` è il primo valore stringa non vuoto dell'input in
ordine di chiave, escluse le chiavi che non descrivono l'intento (`libraryId`,
`id`, `token`, `apiKey`, `signal`); se non ne resta nessuno, `detail` è assente.

**Rimozione del summarizer LLM dal percorso tool.** `llmSummarize`,
`summarizeToolLine`, `SummarizeQueue`, `summaryCache` e `OllamaClient.summarize`
escono. `OllamaClient` resta per `hasVision`, `modelContext`, `listModels`. Si
guadagna: nessuna latenza, nessun timeout di 5s, output riproducibile e
testabile. Si perde: la frase in linguaggio naturale nella lingua della
conversazione — sostituita dalla `description` del modello, che è già nella
lingua giusta e più accurata.

### 3.3 Tool result: segnalare i fallimenti

`ToolBurstAggregator` tiene una mappa `toolUseId → indice della riga` nella bolla
aperta. All'arrivo di un `session.tool` con `kind: 'tool_result'` e
`isError: true`, la riga corrispondente viene riscritta in place:

```
❌ ⚡ Bash · Check image tooling availability
   command not found: cwebp
```

I **successi restano muti**. Motivo: l'`EditThrottler` è a 1 operazione/secondo
per chat; marcare ogni successo raddoppierebbe le chiamate API per nessuna
informazione (l'assenza di ❌ *è* il successo) e riempirebbe la bolla di spunte.

Il messaggio di errore è la prima riga non vuota del `result`, troncata a 100
caratteri. Se la bolla è già stata chiusa quando arriva il risultato, il
fallimento viene ignorato: riaprirla romperebbe l'ordine cronologico della chat.

### 3.4 `mdToHtml()`: leggibilità dei testi

Aggiunte:

- ` ```ts ` → `<pre><code class="language-ts">` — evidenziazione della sintassi.
  Il linguaggio viene passato solo se corrisponde a `^[a-z0-9+#-]{1,20}$`.
- `> citazione` → `<blockquote>`, righe consecutive unite in un solo blocco.
- `~~testo~~` → `<s>testo</s>`.
- Liste ordinate (`1.`) preservate; liste annidate indentate con `•` / `◦`.
- `---` / `***` → riga separatrice.
- Tabelle markdown → `<pre>` con colonne allineate a larghezza fissa (oggi
  escono come righe di pipe illeggibili).
- Heading: `<b>` più una riga vuota prima, così le sezioni si staccano.

**Vincoli Telegram da rispettare** (verificare in implementazione, non assumere):
- `balanceHtml` e `splitHtmlMessage` devono imparare i tag nuovi
  (`blockquote`, `s`, `u`). **Se non lo fanno, aggiungere `blockquote` rompe lo
  split** e i messaggi lunghi spariscono in silenzio — l'invio è dentro un
  `.catch()`.
- I `blockquote` non sono annidabili e non possono contenere `<pre>`. Il
  renderer non deve mai produrre queste combinazioni.

Lo split preferisce, nell'ordine: confine di paragrafo (`\n\n`) → confine di riga
→ spazio. Quando un testo viene spezzato in più di un messaggio, ogni parte porta
in coda un marcatore `<i>(1/3)</i>`; con una parte sola non compare nulla.

### 3.5 Igiene dei messaggi

- **`disable_notification: true` sulle bolle tool.** Notificano solo: risposta
  del modello, domanda, richiesta di permesso, dialogo, errore — cioè gli eventi
  che richiedono una persona. Le tool call restano visibili ma silenziose.
- **`link_preview_options: { is_disabled: true }`** su ogni messaggio di stream.
- **Bolla tool collassabile**: alla chiusura del turno la bolla viene riscritta
  come `<blockquote expandable>` con intestazione `▸ {n} passaggi`. Resta
  consultabile ma smette di occupare lo schermo nello storico.

### 3.6 Subagent: una scheda per agent, dettagli a richiesta

L'SDK offre già tutto il necessario; oggi non ne usiamo niente.

| Segnale SDK | Contenuto utile |
|---|---|
| `parent_tool_use_id` (su assistant e user message) | non-null ⇒ il messaggio viene da un subagent; il valore è l'id della tool call `Task` che l'ha generato |
| `system` / `task_started` | `task_id`, `tool_use_id`, `description`, `subagent_type`, `prompt` |
| `system` / `task_progress` | `usage.tool_uses`, `usage.duration_ms`, `usage.total_tokens`, `last_tool_name`, `summary` |
| `system` / `task_updated` | `patch.status`: `running` \| `completed` \| `failed` \| `killed` \| `paused`, `patch.error` |

**Contratto del bus** (`src/types.ts`): `session.text` e `session.tool`
guadagnano un campo opzionale `parentToolUseId`. Nasce un evento nuovo:

```ts
| {
    type: 'session.agent';
    sessionId: string;
    taskId: string;
    toolUseId?: string;          // la tool_use Task: chiave di correlazione
    phase: 'started' | 'progress' | 'done';
    subagentType?: string;
    description?: string;
    toolUses?: number;
    durationMs?: number;
    lastToolName?: string;
    status?: 'completed' | 'failed' | 'killed';
    error?: string;
    eventId?: string;
  }
```

**`sdk-driver.ts`**: propaga `msg.parent_tool_use_id ?? undefined` su ogni
`session.text` e `session.tool` che emette, e traduce i tre messaggi `system`
in `session.agent`. Nessun'altra modifica al driver.

**Bot**: una `AgentCardRegistry` per sessione tiene, per `toolUseId`, la scheda:
`{ messageId, subagentType, description, lines[], expanded, toolUses, startedAt, status }`.

- Un `session.tool` o `session.text` **con `parentToolUseId`** non entra nello
  stream principale e non tocca la `ToolBurstAggregator`: viene reso con
  `renderToolLine` e accodato a `lines` della scheda corrispondente.
- **Collassata** (default) la scheda è un messaggio solo:
  ```
  🤖 Agent · Explore — trova i punti di rendering
  ⏳ 7 passaggi · 42s · ultimo: Grep
  ```
  con un bottone inline `👁 Dettagli`.
- **Espansa**: stessa intestazione più `<blockquote expandable>` con le righe
  accumulate, bottone `🙈 Nascondi`. Continua ad aggiornarsi dal vivo.
- **Conclusa**: `✅ 🤖 Agent · Explore — … · 12 passaggi · 1m 40s`, oppure
  `❌` con `patch.error` in caso di `failed`/`killed`. Il bottone resta, così i
  dettagli si possono aprire anche dopo.

Questo è esattamente il comportamento richiesto: di default sai *che* un agent
lavora e *quando* finisce; i dettagli sono a un tap di distanza e non vengono mai
buttati via.

**Dettagli che decidono se funziona o no:**

- **Eventi orfani.** Un `tool_use` del subagent può arrivare *prima* del
  `task_started` che crea la scheda. Gli eventi con un `parentToolUseId` senza
  scheda vanno in un buffer per quell'id e sono attaccati alla scheda quando
  nasce. Un buffer che non trova mai la sua scheda viene scartato a fine turno.
- **`tool_use_id` è opzionale** nei tipi SDK (`tool_use_id?: string`). Se manca,
  la scheda è indicizzata per `task_id` e la correlazione con i tool del subagent
  non è possibile: in quel caso la scheda mostra solo i contatori di
  `task_progress` (che restano corretti) e gli eventi con `parentToolUseId`
  ignoto **tornano nello stream principale** invece di sparire. Perdere
  visibilità è peggio che perdere l'ordinamento.
- **Frequenza degli aggiornamenti.** `task_progress` può arrivare molto spesso.
  L'edit della scheda passa dall'`EditThrottler` esistente (1 op/s per chat) e
  viene saltato se il testo renderizzato non è cambiato.
- **`callback_data`** ha un limite di 64 byte: `agent:toggle:` (13) + UUID (36)
  = 49 byte. Rientra, ma il limite va verificato nel test.
- **Notifiche**: le schede agent sono `disable_notification: true`, come le bolle
  tool. Un agent che finisce non è un evento che richiede una persona.

**Limite dichiarato**: tutto questo vale per le sessioni **headless** (percorso
SDK). Le sessioni **terminali** ricevono gli eventi dal transcript, e i subagent
del CLI scrivono su un file transcript separato che il `TranscriptWatcher` evita
deliberatamente di agganciare (commit `c8b4da3`). Per quelle sessioni resta
visibile solo la riga `🤖 Agent` della tool call `Task`, senza scheda e senza
dettagli. Estendere la copertura alle terminali significa far seguire al watcher
i transcript figli: è un lavoro sul plumbing delle sessioni, non sulla
presentazione, e sta fuori da questo branch.

## 4. Fuori scope

- **`@grammyjs/stream`.** `grammy` è il framework Telegram che il progetto già
  usa (una delle tre dipendenze). `@grammyjs/stream` è un suo *plugin* separato:
  sfrutta i "message draft" dell'API Telegram — il testo che compare
  progressivamente in chat, come quando qualcuno sta scrivendo — per far
  apparire l'output del modello mentre viene generato, invece che a blocchi già
  completi, gestendo da solo lo split a 4096 caratteri.
  Escluso, confermato dall'utente, per tre motivi in ordine di peso:
  1. **Non risolve nessuno dei quattro problemi.** Cambia *come arriva* il testo,
     non *quanto è leggibile*: una risposta lunga che si scrive dal vivo resta un
     muro se il markdown è reso male. La leggibilità è il punto 3, e si risolve
     in `mdToHtml`.
  2. Sostituirebbe `forwardText` + `EditThrottler` + la logica di merge su
     `lastMsg`, che contiene la soppressione dell'echo e la deduplica — codice
     sottile, con bug già trovati e commentati.
  3. È una dipendenza runtime nuova, e il `CLAUDE.md` fissa il budget a tre.
- **`setMyCommands()`** (menu `/` di Telegram popolato con i comandi e le loro
  descrizioni). Proposto e **scartato dall'utente**: è discovery dei comandi, non
  leggibilità della chat, ed è l'unico intervento che tocca il ciclo di avvio del
  bot invece del solo rendering.
  **Aggiornamento (0.4.0):** è arrivato comunque, per altra via, col merge di
  `feat/settings-diag` (`bot/telegram.ts`, `setMyCommands` nell'avvio del bot).
  Nessun task di questo piano lo tocca: resta fuori scope, ma non è più
  "mancante".
- Supergruppi e topic (esclusi esplicitamente dall'utente).
- Invio degli output lunghi come documento (`sendDocument`).

## 5. Rischi

| Rischio | Mitigazione |
|---|---|
| I nuovi tag HTML rompono `splitHtmlMessage` → messaggi persi in silenzio | Estendere le regex **nello stesso commit** dei tag nuovi; test dedicato con blockquote a cavallo del limite di 3800 char |
| `blockquote expandable` non supportato da un client vecchio | Degrada a citazione normale, nessuna perdita di testo |
| La rimozione del summarizer LLM peggiora casi che oggi funzionano bene | Il catalogo copre esplicitamente ogni tool visto nei transcript reali; il ramo generico resta come rete |
| Il rendering delle tabelle in `<pre>` sfora in larghezza su schermi stretti | Larghezza massima per colonna, con troncamento |
| Un bug nel routing per `parentToolUseId` fa **sparire** l'attività di un subagent dalla chat | Il ramo di fallback è esplicito: `parentToolUseId` senza scheda ⇒ l'evento torna nello stream principale. Test dedicato sul caso "scheda mai creata" |
| Le schede agent saturano l'`EditThrottler` (1 op/s) e ritardano il testo del modello | L'edit è saltato se il testo renderizzato non cambia; `task_progress` non forza un edit per sé |
| Un subagent lasciato "in corso" per sempre se `task_updated` non arriva mai | A fine turno (`session.result` / `session.error`) ogni scheda ancora aperta viene chiusa come interrotta |

## 6. Verifica

- `npm run typecheck` e `npm test` (il cancello di CI).
- Test nuovi in `test/render.test.ts`: `describeTool` per ogni voce del catalogo,
  `shortenPath` (dentro progetto / dentro home / fuori da entrambi), parsing MCP,
  `mdToHtml` per ogni costrutto aggiunto, `splitHtmlMessage` con i tag nuovi a
  cavallo del limite.
- Test nuovi per le schede agent: creazione da `task_started`, eventi orfani
  attaccati a posteriori, `parentToolUseId` senza scheda che ricade nello stream
  principale, toggle espandi/collassa, chiusura forzata a fine turno, lunghezza
  del `callback_data` sotto i 64 byte.
- Non verificabile in CI e da dichiarare come tale: la resa reale su Telegram
  (evidenziazione della sintassi, blockquote espandibile, comportamento delle
  notifiche) richiede un token bot e un telefono.
