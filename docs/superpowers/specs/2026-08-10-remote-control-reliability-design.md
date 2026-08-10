# Affidabilità del remote control — Design Document

**Data**: 2026-08-10
**Stato**: da revisionare da parte dell'utente
**Branch**: `feat/remote-control-reliability`

## 1. Problema

Il servizio deve reggere ogni casistica, incluse quelle limite: un evento non deve
mai sparire, una sessione non deve mai restare bloccata in silenzio, e quando
qualcosa va storto deve essere possibile capire *dove*.

Oggi non è così. Il caso che ha aperto questo lavoro è riproducibile al 100% ed è
stato osservato due volte di fila, in questa stessa sessione:

1. Le bolle `⚙️` delle tool call arrivano su Telegram.
2. Il testo del modello che le segue **non arriva**.
3. La domanda a scelta multipla (`AskUserQuestion`) che segue quel testo **non
   arriva**: la sessione resta ferma in attesa di una risposta che dal telefono
   non è possibile dare, e sembra "impallata".
4. `/view` mostra il menu aperto nel pane tmux: l'unico modo per accorgersene.

Il secondo obiettivo è la parità di comportamento: una sessione pilotata dal
telefono funziona in modo diverso da una pilotata dalla TUI (niente UI a schermo
intero, markdown ridotto, allegati come percorsi di file, spesso un modello senza
input immagini), ma il modello non lo sa e si comporta come se fosse al terminale.

**Criteri di successo**

- Nessun evento destinato a Telegram può essere perso o riordinato, nemmeno in
  presenza di rete assente, riavvio del daemon o limite di frequenza dell'API.
- Nessuna sessione può restare in attesa senza che l'utente lo sappia, qualunque
  sia il lato da cui l'interazione è stata risolta.
- Ogni evento scartato lascia una traccia con il motivo dello scarto.
- Il modello riceve, a inizio sessione, i vincoli reali del canale su cui sta
  parlando.

## 2. Evidenza raccolta

### 2.1 Firma del fallimento

Claude Code scrive il transcript una riga JSON per blocco, con lo **stesso**
message id. Entrambi i fallimenti hanno questa forma:

```
riga N     assistant  mid=X  blocks=thinking
riga N+1   assistant  mid=X  blocks=text                      ← non consegnato
riga N+2   assistant  mid=X  blocks=tool_use:AskUserQuestion   ← non consegnato
```

Verificato sul transcript reale
(`~/.claude/projects/<progetto>/<sessione>.jsonl`, righe 53-55 e 10-12 della coda
del file). Il blocco `thinking` come riga separata è prodotto da `claude-opus-5`
con effort alto: un modello Ollama senza extended thinking non genera quella
forma. Il percorso è stato tarato su una forma di messaggio e ne incontra
un'altra — da cui la regola in §7: i test del parser vanno su fixture reali di
entrambi i mondi.

`TranscriptParser.consumeLine` letto in isolamento gestisce correttamente le tre
righe (emette `text` e `prompt`). La perdita è a valle, nel bot.

### 2.2 Nessuna eccezione è stata sollevata

`daemon.log` e `daemon.err.log` sono a 0 byte con il daemon vivo dalle 17:10.
Su POSIX `process.stdout` verso un **file** è sincrono (verificato: 101 byte già
su disco subito dopo la write), quindi non è bufferizzazione: dal riavvio il
daemon non ha scritto nulla, nemmeno una riga di avvio.

Conseguenza diagnostica: gli eventi non sono stati persi da un throw, ma
**scartati da una guardia silenziosa** — uno dei molti `return` senza traccia nel
bot (non armato, sessione non attiva, nessuna chat collegata, bolla chiusa,
generazione superata). È la classe di difetto che §5.4 rende impossibile.

### 2.3 Difetto dimostrato: il flow che resta appeso

Indipendente dal precedente, e dimostrato per lettura del codice:
`onSessionPrompt` mostra una domanda solo se `setIndex === 0 && qIndex === 0 &&
!messageId`; il flow viene ripulito (`deleteFlow`) **solo** percorrendo la strada
Telegram. Se rispondi alla domanda **dal terminale**, il bot non lo viene mai a
sapere: il flow resta aperto per sempre e ogni domanda successiva di quella
sessione viene accodata in silenzio. Vale identico per un permesso risolto nel
pane dopo la scadenza dell'hook.

Il transcript però lo dice: il `tool_result` della tool call compare su disco.
Il fatto è osservabile — semplicemente, oggi nessuno lo osserva.

## 3. Situazione attuale

- **Consegna fire-and-forget su stato in memoria.** Ogni handler del bus parla
  direttamente all'API Telegram: `void forwardText(...)`, `burst.push(...)`,
  `showQuestion(...)` partono in parallelo, ognuno con il proprio stato
  (`open`, `generation`, `lastWasTool`, `SummarizeQueue.gen`, `lastMsg`).
  L'ordine di arrivo dipende da chi risolve prima.
- **Le summary delle tool call passano da una chiamata LLM**, quindi arrivano
  sempre in ritardo rispetto al testo che le segue, e si incrociano con
  `toolBurst.close()` / `resetSummarize()` che testo, domande, permessi ed errori
  scatenano. Tre meccanismi di sincronizzazione (catena di promise, contatore di
  generazione, contatori della coda) esistono solo per contenere questa gara.
- **Niente persistenza della coda in uscita**: ciò che non è partito quando il
  daemon muore è perso.
- **Il bot è la sola fonte di verità sui pendenti**, ma le sessioni terminali
  hanno due input (tastiera e Telegram).
- **Nessun logging**: solo `console.error` sui cammini di errore, nessun livello,
  nessuna rotazione, nessuna traccia dei cammini normali né degli scarti.
- **`bot/telegram.ts` è a 2006 righe** e contiene resa, throttling, aggregazione,
  ritentativi, macchine a stati dei dialoghi e routing dei comandi.
- **Nessun contesto di sessione**: `sdk-driver.ts` chiama `query({...})` senza
  system prompt; `attach.sh` non restituisce contesto aggiuntivo.

## 4. Decisioni prese

| Tema | Decisione |
|---|---|
| Ampiezza | Riscrivere il percorso di consegna (non fix puntuali, non riscrittura completa del bot) |
| Durabilità | Coda persistita su disco, consegnata al ritorno |
| Riconsegna dell'arretrato | Riassunto + consegna integrale solo di ciò che è azionabile |
| Doppio controllo | Riconciliazione completa dal transcript; **nessun** pilotaggio di UI a schermo intero |
| Guardrail | Sessioni headless sempre; sessioni terminali se avviate da `omni-rc` |
| Contenuto guardrail | Fatti sul canale + regole operative che ne discendono |
| Osservabilità | Log strutturati con rotazione + tracciamento end-to-end + `/diag` + autodiagnosi |
| Verifica | Fixture reali + percorso completo con trasporto finto + avversità + checklist manuale |

## 5. Design

### 5.1 Percorso di consegna: un solo scrittore, un ordine solo

Ogni cosa destinata a Telegram diventa un **record** con identità propria:

```
id            identificativo univoco, assegnato alla nascita
seq           numero di sequenza monotono per chat
sessionId     sessione di origine
kind          text | tool | prompt | permission | dialog | notice
payload       contenuto (per i tool: descrizione di ripiego + slot summary)
createdAt     istante di creazione
state         pending | sent | failed | dropped
reason        motivo, obbligatorio per failed e dropped
messageId     id del messaggio Telegram, una volta consegnato
```

I gestori del bus **non inviano più nulla**: costruiscono il record e lo
accodano. Nessun `await`, nessuno stato condiviso, nessuna gara.

Un **writer unico e sequenziale per chat** consuma la coda in ordine di `seq`:
rende il contenuto, invia tramite il trasporto, gestisce i rifiuti (limite di
frequenza con l'attesa richiesta dal server, timeout, HTML rifiutato, messaggio
troppo lungo) con ritentativi ad attesa crescente, e marca l'esito. È l'**unico**
punto del sistema che parla in uscita: l'ordine sul telefono è per costruzione
l'ordine in cui i fatti sono accaduti.

Tre conseguenze che eliminano classi di difetti invece di sintomi:

1. **L'aggregazione delle bolle `⚙️` si sposta dentro il writer.** Raggruppare
   tool call consecutive diventa una decisione di resa su uno stream già
   ordinato. `ToolBurstAggregator.close()`, il contatore di generazione e
   `SummarizeQueue` — i tre meccanismi che oggi si incrociano — spariscono.
2. **Le summary via LLM non possono più arrivare "dopo".** Il record è accodato
   subito con la descrizione di ripiego (`summarizeTool`, già esistente e puro);
   quando la summary è pronta **aggiorna quel record per id**. Oltre una
   scadenza, resta il ripiego. Un ritardo del provider non può più riordinare né
   perdere nulla.
3. **La coda è su disco**: journal append-only accanto a `state.json`, scritto
   prima del tentativo di invio. Riavvio del daemon o rete assente non perdono
   niente; al ritorno il writer riprende dal primo `pending`.

**Trasporto astratto.** `send` / `edit` / `delete` dietro un'interfaccia minima,
con l'implementazione grammy e un doppio per i test. È ciò che rende asseribile
l'intero percorso senza rete, inclusi i fallimenti.

**Riconsegna dell'arretrato.** Alla ripresa, il writer non riversa la storia: un
messaggio di sintesi (quante sessioni, quante tool call, quanto tempo), poi la
consegna integrale del solo materiale azionabile — interazioni ancora pendenti e
ultimo messaggio del modello per sessione. Il resto resta raggiungibile con
`/history`. I record collassati passano a `dropped` con motivo `compacted`, non
scompaiono dal journal.

**Compattazione e rotazione del journal.** I record in stato terminale più
vecchi di una soglia vengono rimossi alla rotazione; il journal non cresce senza
limite.

### 5.2 Guardrail di sessione

**Sorgente unica.** Il testo dei guardrail vive in un modulo TypeScript ed è
generato in funzione del contesto: tipo di sessione (headless/terminale),
capacità del modello (`ollama.hasVision`, già esistente), modalità permessi.
Le parti che dipendono da una condizione compaiono solo quando è vera — un
guardrail falso è peggio di nessun guardrail.

**Innesto, senza nuovi pezzi.**

- *Headless*: in append al preset di Claude Code nella chiamata `query({...})`
  di `sdk-driver.ts`. Sempre.
- *Terminali*: `omni-rc` esporta un marcatore nell'ambiente tmux; `attach.sh`
  (già hook `SessionStart`, già produttore di JSON su stdout) lo legge e, solo in
  quel caso, restituisce il contesto aggiuntivo. Il testo arriva **dal daemon**
  nella risposta a `/api/attach`, cioè nella chiamata che l'hook fa già: una sola
  sorgente, modellata sul modello reale. Daemon giù → nessun contesto e sessione
  normale, coerente con il fail-open già adottato per i permessi.

**Contenuto** — fatti verificabili, poi le regole che ne discendono:

- l'output è letto su Telegram: markdown ridotto, messaggi spezzati oltre una
  certa lunghezza, nessuna UI a schermo intero;
- se il modello non ha input immagini: gli allegati arrivano come percorsi di
  file e questo va dichiarato, mai simulato;
- le domande a scelta multipla diventano bottoni: poche opzioni, etichette corte;
- nelle sessioni terminali il piano si approva solo al terminale: da remoto non
  ci si deve parcheggiare;
- risposte compatte, niente tabelle larghe.

**Costi accettati**: è contesto pagato a ogni sessione e può entrare in tensione
con le istruzioni di progetto. Resta quindi corto (poche righe) e disattivabile
da `.env`.

### 5.3 Riconciliazione: il transcript è la verità

Ogni interazione pendente (domanda, permesso, dialogo) diventa un record
persistito, **agganciato all'id della tool call del CLI** quando esiste. La
chiusura arriva da chi la osserva per primo, non solo dal percorso Telegram.

| Evento osservato | Comportamento |
|---|---|
| `tool_result` della tool call pendente compare nel transcript | L'interazione è stata risolta nel pane: il messaggio Telegram viene chiuso con l'esito reale (`risposto dal terminale: <opzione>`), i bottoni ritirati, il flow ripulito, la domanda successiva in coda mostrata subito |
| Risposta inviata da Telegram e iniettata nel pane | Non si dà per riuscita: se entro una finestra il `tool_result` non compare, l'utente viene avvisato invece di restare a credere che sia andata |
| Turno annullato al terminale (Esc, `/clear`, sessione chiusa) | I bottoni pendenti vengono ritirati con il motivo, invece di restare cliccabili su qualcosa che non esiste |
| Avvio del daemon con pendenti persistiti | Ognuno viene confrontato con il transcript: risolto → chiuso; ancora aperto → riproposto |

Il difetto di §2.3 diventa impossibile per costruzione: il flow non è più
chiudibile solo dal lato Telegram.

**Fuori da questa sezione**, per scelta: pilotare da Telegram le UI a schermo
intero del CLI (approvazione del piano nelle sessioni terminali). Richiederebbe
iniezione di tasti e lettura dello schermo, fragile a ogni aggiornamento del CLI.
Resta il limite noto, documentato.

### 5.4 Osservabilità

**Log strutturati.** Una riga JSON per evento (livello, istante, sessione, id
record, fase, esito), livello da `.env`, rotazione a dimensione con un numero
fisso di file conservati. Scrittura diretta su descrittore, senza stream
intermedi, così il file è leggibile mentre le cose accadono.

**Tracciamento end-to-end.** Il record porta il proprio id dalla riga di
transcript fino al `message_id` di Telegram. Il valore non sta nei successi ma
negli **scarti volontari**: ogni `return` silenzioso di oggi (non armato,
sessione non attiva, nessuna chat collegata, bolla chiusa, generazione superata)
diventa uno scarto esplicito con motivo. È esattamente l'informazione che è
mancata in §2.2.

**`/diag` da Telegram.** Sessioni tracciate con transcript e ritardo del tail,
profondità della coda e più vecchio record non consegnato, interazioni pendenti,
ultimi errori, stato di tmux e del provider, stato armato, versione. Diagnosi
senza aprire un terminale — cioè nella situazione in cui il servizio serve.

**Autodiagnosi.** Controllo periodico di invarianti; alla violazione, notifica:

- la coda non scende da oltre N secondi pur avendo record pendenti;
- una sessione risulta in attesa senza alcuna interazione pendente;
- il transcript cresce ma il tail non avanza;
- una risposta è stata consegnata ma il `tool_result` non è mai comparso;
- un permesso è pendente oltre la propria scadenza.

## 6. Moduli e file

| Modulo | Ruolo |
|---|---|
| `src/log.ts` *(nuovo)* | log strutturato, livelli, rotazione, scrittura diretta |
| `src/delivery/record.ts` *(nuovo)* | tipo del record, stati, motivi di scarto |
| `src/delivery/outbox.ts` *(nuovo)* | journal append-only + indice in memoria; `enqueue` / `update` / `ack` / `fail` / `drop` / `pending`; compattazione |
| `src/delivery/writer.ts` *(nuovo)* | writer sequenziale per chat: resa, aggregazione delle bolle, ritentativi, riconsegna dell'arretrato |
| `src/delivery/transport.ts` *(nuovo)* | interfaccia `send` / `edit` / `delete`; implementazione grammy + doppio per i test |
| `src/sessions/reconciler.ts` *(nuovo)* | pendenti persistiti, osservazione del transcript, chiusura da entrambi i lati, riconciliazione all'avvio |
| `src/guardrails.ts` *(nuovo)* | generazione del testo dei guardrail in funzione di sessione e capacità del modello |
| `src/health.ts` *(nuovo)* | invarianti e autodiagnosi |
| `bot/telegram.ts` | perde resa-verso-la-rete, throttling, bolle e ritentativi; resta con comandi e macchine a stati dei dialoghi; guadagna `/diag` |
| `src/sessions/transcript.ts` | robustezza del parser (§8), esposizione dei `tool_result` per la riconciliazione |
| `src/sessions/transcript-watcher.ts` | niente ricreazione del tail che salti righe; gestione di riscrittura e compattazione |
| `src/sessions/sdk-driver.ts` | guardrail in append al preset |
| `src/api.ts` | risposta di `/api/attach` con il testo dei guardrail |
| `scripts/attach.sh` | contesto aggiuntivo se il marcatore `omni-rc` è presente |
| `scripts/omni-rc.sh` | esporta il marcatore nell'ambiente tmux |
| `src/config.ts` | livello di log, dimensione di rotazione, interruttore dei guardrail, soglie dell'autodiagnosi |

## 7. Casistiche limite

Per ognuna deve esistere un comportamento dichiarato.

**Transcript e CLI**

| Caso | Comportamento |
|---|---|
| Blocchi dello stesso messaggio su righe separate (`thinking`/`text`/`tool_use`) | Ogni blocco emesso una volta sola; deduplicazione per id di blocco, non per id di messaggio |
| Ultima riga ancora in scrittura | Conservata nel buffer e completata al giro successivo; mai consumata a metà |
| Transcript riscritto o accorciato (compattazione) | Riconosciuto e ripreso senza saltare a fine file perdendo il contenuto intermedio |
| Sessione spostata in un worktree | Transcript ri-scoperto (già gestito, mantenuto e coperto da test) |
| Più transcript nella stessa cartella | Nessuna adozione di un file di un'altra sessione; il cambio di file non ricrea un tail che riparta da fine file |
| Sessione senza transcript | Sola cattura schermo via `/view`, dichiarata all'utente |
| Righe di servizio (`/clear`, `/compact`, cambi modalità) | Non inoltrate e non usate per dedurre lo stato |
| Turno interrotto per limite di output | Errore esplicito una sola volta |
| Schema cambiato da un aggiornamento del CLI | Il parser degrada a "non lo so" e lo registra; mai scarto silenzioso |

**tmux**

| Caso | Comportamento |
|---|---|
| Server assente, pane chiuso, sessione rinominata | Errore leggibile all'utente, sessione marcata, nessun crash |
| Comando che non risponde | Scadenza e errore leggibile |
| Iniezione in un pane non pronto | La riconciliazione rileva la mancata risoluzione e avvisa |
| Pane tornato alla shell | Sessione rimossa dal registro |
| Testo con ritorni a capo o caratteri interpretati dal paste | Normalizzato prima dell'iniezione |

**Telegram**

| Caso | Comportamento |
|---|---|
| Limite di frequenza | Attesa richiesta dal server, poi ritentativo; nessuna perdita |
| Messaggio oltre il limite di lunghezza | Diviso ai confini di riga, tag riaperti (già gestito, mantenuto) |
| HTML rifiutato | Ritentativo in testo semplice; il contenuto arriva comunque |
| Modifica di un messaggio troppo vecchio o identico | Trattata come esito benigno, registrata, mai come perdita |
| Rete assente a lungo | Coda persistita; riconsegna con riassunto al ritorno |
| Nessuna chat collegata | Record in `pending`, non scartati; consegnati al primo collegamento |
| Messaggio cancellato dall'utente | Modifica fallita → nuovo messaggio |
| Bottone premuto dopo un riavvio | Riferimento non più valido → risposta esplicita, mai silenzio |

**Daemon e sistema**

| Caso | Comportamento |
|---|---|
| Riavvio a metà dialogo | Pendenti riconciliati all'avvio (§5.3) |
| Sospensione e risveglio con salto dell'orologio | Tutte le scadenze basate su intervalli monotoni, mai su istanti assoluti |
| `state.json` o journal corrotti | File conservato a parte e segnalato; ripartenza senza perdita silenziosa |
| Porta API occupata | Errore esplicito all'avvio |
| Due istanze avviate | La seconda rileva la prima e si rifiuta di partire |
| Log che cresce | Rotazione a dimensione |
| Riavvio in ciclo | Rilevato e notificato dall'autodiagnosi |

**Concorrenza**

| Caso | Comportamento |
|---|---|
| Due sessioni che chiedono insieme | Interazioni in coda per sessione, mostrate con l'identificativo di sessione |
| Sessione attiva cambiata con un dialogo aperto | Il dialogo resta legato alla propria sessione, non a quella attiva |
| Risposta a una domanda di sessione non selezionata | Consegnata alla sessione corretta |
| `/stop` durante un dialogo | Pendenti annullati con motivo, esito reale riportato |
| Sessione eliminata con pendenti | Pendenti annullati, record marcati |
| Stessa riga riletta | Deduplicazione per id di blocco: nessun doppione |

**Provider**

| Caso | Comportamento |
|---|---|
| Provider irraggiungibile durante una summary | Descrizione di ripiego, mai un buco né un ritardo nella consegna |
| Modello senza input immagini | Dichiarato nei guardrail e all'utente al momento dell'invio |
| `/usage` non disponibile | Messaggio con l'azione da compiere (già gestito, mantenuto) |

## 8. Verifica

1. **Fixture di transcript reali** — catturate da sessioni vere e diverse:
   Opus con `thinking` (la fixture del caso di §2.1), un modello Ollama, una
   sessione compattata, un worktree, un turno interrotto. Rigiocate contro
   parser e percorso di consegna.
2. **Percorso completo con trasporto finto** — il doppio registra ciò che
   l'utente vedrebbe: si asserisce dalla riga scritta su disco al messaggio
   finale, senza rete. Inclusi i fallimenti: limite di frequenza, timeout,
   modifiche rifiutate, HTML rifiutato.
3. **Test delle avversità** — guasti iniettati: tmux che sparisce a metà, daemon
   ucciso con una domanda pendente, rete che cade tra due messaggi, riga
   troncata, orologio che salta. Asserzione invariante: nulla perso, nulla
   bloccato.
4. **Checklist manuale dal telefono**, prima di ogni rilascio: domanda
   multi-select, risposta data dal terminale, riavvio del daemon a metà dialogo,
   sospensione e risveglio della macchina, rete tolta e rimessa.
5. `npm run typecheck && npm test` verdi.

## 9. Fasi

Cinque, ognuna rilasciabile e verificabile da sola.

1. **Osservabilità** — log strutturati con rotazione, tracciamento con id, scarti
   espliciti, `/diag`. Prima di tutto: è ciò che permette di *dimostrare* le fasi
   successive. Qui si conferma la causa esatta del caso di §2.1 con lo strumento
   in mano.
2. **Percorso di consegna** — record, journal, writer unico, trasporto astratto,
   aggregazione spostata nel writer, ritentativi, riconsegna dell'arretrato.
3. **Riconciliazione** — pendenti persistiti, transcript come verità, sblocco
   all'avvio, autodiagnosi.
4. **Guardrail di sessione** — indipendente dalle altre, anticipabile.
5. **Copertura e verifica** — casistiche di §7 completate, avversità, checklist.

## 10. Fuori scope

- Pilotaggio da Telegram delle UI a schermo intero del CLI (approvazione del
  piano nelle sessioni terminali): resta un limite documentato.
- Riscrittura completa di `bot/telegram.ts`: il file si alleggerisce come
  conseguenza dell'estrazione del percorso di consegna, non come obiettivo.
- Pipeline di input immagini per i modelli che non la supportano.
- App dedicata al posto di Telegram.
