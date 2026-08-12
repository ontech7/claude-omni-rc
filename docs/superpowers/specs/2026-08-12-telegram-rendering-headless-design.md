# Rendering Telegram + parità headless — Design Document

**Data**: 2026-08-12
**Branch**: (da creare — es. `feat/readable-sessions-tables-headless`)
**Stato**: da revisionare da parte dell'utente

## 1. Problema

Quattro disturbi segnalati dall'utente:

1. **`/sessions` è difficile da leggere.** Ogni sessione sta su una riga con più
   informazioni separate da `·` (`▸ <b>title</b> · kind · <code>target</code> —
   status · 5m ago`); su uno schermo stretto la riga va a capo e le informazioni
   si confondono. Inoltre il marcatore della sessione selezionata è `▸` (U+25B8),
   una "freccetta" ambigua.
2. **`/diag` ha lo stesso problema.** La riga di ogni sessione
   (`• <code>id8</code> title — kind · status · tmux · transcript — model · effort · branch`)
   va a capo e si legge male.
3. **Le tabelle markdown non vengono renderizzate.** Quando il CLI restituisce
   output tabellare in markdown, da Telegram le tabelle risultano illeggibili
   (pipe grezze o testo troncato).
4. **La sessione headless è più bloccante della tmux.** Il modello riferiva
   "non riesco a usare bash / accesso negato" in headless, cosa che in tmux non
   succedeva.

## 2. Situazione attuale (verificata su codice e transcript reali)

### 2.1 `/sessions` e `/diag`

- `sessionListText()` (`bot/telegram.ts:687`): una riga per sessione, marker
  `▸`/spazio, tutto concatenato.
- `diagReport()` (`bot/telegram.ts:726`): id troncato, titolo, e poi 7+ fatti
  concatenati sulla stessa riga.
- Entrambe sono funzioni pure esportate, testate in `test/telegram.test.ts`.

### 2.2 Tabelle

`mdToHtml()` (`bot/render.ts:16`) converte già le tabelle a pipe complete
`| ... |` + riga separatrice in `<pre>` a larghezza fissa (righe 36-58), con
limiti noti:

- **Il testo streamma a pezzi e la conversione avviene per pezzo.** Il
  `TranscriptParser` deduplica i blocchi di testo per `message id` e il CLI
  riscrive lo stesso id con testo crescente: nei transcript reali
  (`~/.claude/projects/**`) lo stesso id compare con testo sempre più lungo
  (es. 104 → 1387 caratteri). Il parser emette **solo la prima versione** →
  messaggi troncati e tabelle mai complete al momento della conversione.
  Nel bot, `session.text` → `mdToHtml(e.text)` per-evento (`telegram.ts:2394`),
  poi `forwardText` concatena **HTML già convertito** (`telegram.ts:1085`): una
  tabella spezzata tra eventi non viene mai riconosciuta.
- **Il matcher è troppo stretto**: non accetta indentazione iniziale né lo stile
  `A | B` senza pipe laterali.
- **Celle troncate a metà parola**: `CELL_MAX = 24` taglia
  `Long col value that exceeds the cell max` → `Long col value that exce`.
- **Markdown grezzo nelle celle**: `**bold**` e backtick restano letterali nel
  `<pre>` (la conversione tabelle gira prima dei pass grassetto/codice).
- **Tabelle dentro blocchi di codice**: restano letterali (protette come
  `<pre>`). A volte è il modello stesso a metterle in un fence nella narrazione.

### 2.3 Permessi headless vs tmux

- **tmux**: il CLI nativo autorizza da solo i tool di sola lettura (Read, Grep,
  Glob, WebFetch, WebSearch) e fa scattare il prompt (hook
  `PermissionRequest` → bottoni Telegram, `scripts/permission-hook.sh`) solo per
  i tool che cambiano stato.
- **headless** (`src/sessions/sdk-driver.ts`, `canUseTool`):
  `permissionMode: 'default'` instrada **ogni** tool call, compresi i read-only,
  attraverso `permissionFlow.request()` → bottoni Telegram con timeout
  `permissionTimeoutSeconds` (default 120s). Se l'utente non guarda il telefono:
  timeout → deny → il modello riporta "accesso negato". È una differenza
  strutturale, non un caso isolato.

## 3. Design

### 3.1 Layout `/sessions` e `/diag` (approvato)

`sessionListText()` → due righe per sessione:

```
● <b>Fix landing</b> · running · 2m ago
  🖥 claude:landing

○ <b>Review PR</b> · idle · 5m ago
  🧠 claude-sonnet-5
```

- Sessione attiva: `●` pieno + titolo in grassetto; le altre `○`.
- Riga 2: icona del tipo (`🖥` terminal / `🧠` headless) + dettaglio (target
  tmux oppure modello). Per le terminali senza tmux: `no tmux`.
- La tastiera inline (id6 + `🗑`) e il re-render su `sess:select` restano
  invariati. Il marcatore `▸` sparisce.
- `diagReport()`: la sezione `Sessions` adotta lo stesso formato a due righe con
  lo stesso indicatore `●/○`; head, pending, errors invariati. Nel /diag il
  dettaglio resta quello di oggi (kind · status · tmux/transcript · model ·
  effort · branch), distribuito sulle due righe.

File toccati: `bot/telegram.ts` (due funzioni pure + test).

### 3.2 Tabelle (approvato)

**a. Streaming corretto (radice).** `TranscriptParser` emette il testo in modo
*incrementale* per message id: se il nuovo testo è un'estensione di quello già
emesso, emette solo la coda (delta); se non è un'estensione (rewrite), non emette
nulla per quell'id. Il turno arriva così completo e live. Test sui casi
"same id, testo crescente" e "rewrite non-estensione".

**b. Conversione sul testo accumulato.** `forwardText` tiene il markdown
**grezzo** nel buffer del messaggio (accanto all'HTML) e converte
`mdToHtml(rawMerged)` a ogni edit, invece di concatenare HTML già convertito. La
conversione vede sempre la tabella completa. Il merge conserva le regole attuali
(stesso ruolo, finestra 10s); il tetto `SEND_MAX_CHARS` si applica all'HTML
**convertito** (oltre si apre un messaggio nuovo).

**c. Matcher più largo** in `mdToHtml`:
- accetta indentazione iniziale (pipe allineate con spazi davanti);
- accetta lo stile senza pipe esterne (`A | B` + riga separatrice) quando c'è la
  riga separatrice;
- **converte anche le tabelle dentro i fence** `` ``` `` quando hanno la forma
  `| ... |` + separatore (l'output letterale di tool — log, CSV — resta
  invariato perché non ha quella forma). Implicazione d'ordine: il pass
  tabelle gira prima della protezione dei fence, quindi un blocco tabellare
  dentro un fence viene convertito e i marcatori ``` attorno a quel blocco
  vengono consumati/rimossi (niente ` ``` ` residue attorno al `<pre>`). Un
  fence con contenuto non-tabellare resta protetto come oggi.

**d. Celle leggibili.** Cap alzato a ~48 caratteri; troncamento con `…` a fine
parola invece che a metà.

**e. Markdown dentro le celle.** `**bold**` e `` `code` `` convertiti dentro il
`<pre>` (Telegram renderizza i tag di formattazione dentro `<pre>`; i tag
aggiunti restano dentro il set conosciuto da `balanceHtml`/`splitHtmlMessage`).

File toccati: `bot/render.ts` (matcher, celle, fence), `bot/telegram.ts`
(forwardText: buffer raw), `src/sessions/transcript.ts` (parser incrementale),
test di `render`, `telegram`, `transcript`.

### 3.3 Permessi headless allineati al CLI nativo (approvato)

In `canUseTool` (`src/sessions/sdk-driver.ts`):

```
AskUserQuestion                → allow (invariato)
permissionMode 'auto'          → allow (invariato)
Read, Grep, Glob, WebFetch, WebSearch  → allow senza chiedere (nuovo)
tutto il resto (Bash, Edit, Write, NotebookEdit, tool MCP, …) → permissionFlow (invariato)
```

Il set read-only è esattamente quello del CLI nativo; `ExitPlanMode` continua a
passare da `permissionFlow` (approvazione/modifica piano via bottoni). Test in
`test/sdk-driver.test.ts` per il nuovo comportamento.

### 3.4 Documentazione delle limitazioni headless (approvato)

Nuova sottosezione **"Headless sessions"** in `AI-GUIDE.md` (in inglese):

- Nessuno schermo terminale → `/view` risponde con la spiegazione; le risposte
  streammano in chat.
- Permessi: sola lettura automatica; le operazioni che cambiano stato richiedono
  i bottoni (timeout default 120s) — per sessioni senza supervisione usare
  `/new --auto` o `DEFAULT_PERMISSION_MODE=auto`.
- `/stop` interrompe il turno in corso; un riavvio del daemon perde il turno a
  metà ma la sessione riprende la storia (resume da `claudeSessionId`).
- Domande a scelta multipla e approvazione piani arrivano come bottoni.
- Comandi slash arbitrari del CLI non sono inoltabili da Telegram: si usano i
  comandi del bot (`/compact`, `/stop`, `/context`).
- Subagent: card `🤖 Agent` espandibili (headless only — la terminale mostra
  solo la riga).

## 4. Testing

- **render**: casi nuovi per matcher (indentato, senza pipe esterne, in fence),
  celle lunghe (truncate con `…`), markdown nelle celle; casi esistenti
  invariati (fence letterali senza forma tabella, pipe dentro i fence).
- **transcript**: parser incrementale — stesso id con testo crescente emette i
  delta; rewrite non-estensione non emette nulla; dedupe esistente invariato.
- **telegram**: `sessionListText`/`diagReport` con il nuovo layout (indicatore
  `●/○`); `forwardText` buffer raw: una tabella spezzata su due eventi arriva
  convertita su Telegram (verifica sul testo passato a `editMessageText`).
- **sdk-driver**: `canUseTool` — read-only passano senza `permissionFlow`,
  Bash/Edit/Write passano dal flow; automode invariato.
- Gate: `npm run typecheck` + `npm test`.

## 5. Criteri di successo

- `/sessions` e `/diag` leggibili anche su schermo stretto; sessione attiva
  riconoscibile senza ambiguità.
- Una tabella markdown prodotta dal modello (in tmux o headless, intera o
  streammata a pezzi, indentata o no, dentro o fuori un fence) arriva in chat
  come tabella a larghezza fissa leggibile, senza celle tagliate a metà parola.
- In headless il modello non riferisce più "accesso negato" per operazioni di
  sola lettura; le operazioni che cambiano stato restano protette dai bottoni.
- Le limitazioni headless sono documentate in `AI-GUIDE.md`.

## 6. Non-goals

- Nessun cambiamento al modello di autorizzazione (default-deny, timeout,
  automode) oltre al set read-only del §3.3.
- Nessun supporto `<table>` HTML (Telegram non lo renderizza): il `<pre>` resta
  il contenitore.
- Non si tocca la UX dei permessi tmux (hook, bottoni, timeout).
