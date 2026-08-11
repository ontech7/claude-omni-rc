# SDD ledger — plan: docs/superpowers/plans/2026-08-11-telegram-chat-ux.md

Branch: feat/telegram-ux, ribasato su main 3f7f406 (release 0.4.0).
Baseline verificata: 382 test, 0 fallimenti con
  env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY npm test
(senza quelle unset, 2 test di sdk-driver falliscono per l'env del daemon:
difetto preesistente su main, fuori scope.)

Nota di pre-flight: il Global Constraint "ogni frammento dinamico passa da
htmlEscape" è soddisfatto DENTRO renderToolLine (Task 3). Per questo il Task 4
prescrive di NON ri-escapare la riga prima di push(): ri-escaparla mostrerebbe
&lt;b&gt; in chat. Non è un'eccezione al vincolo, è il vincolo applicato a un
livello diverso.

Task 1: complete (commits b7fa64f..64467b9, review clean)
Task 1: minor (deferred): il commento di intestazione di bot/render.ts è in
  italiano perché il brief lo detta alla lettera, ma i Global Constraints e il
  CLAUDE.md impongono commenti NUOVI in inglese. RULING (controller): vince il
  vincolo, non il testo del brief. Il piano contraddice sé stesso perché i suoi
  blocchi di codice hanno commenti italiani. Da Task 2 in poi ogni dispatch
  istruisce: contenuto del commento come da brief, LINGUA inglese. La riparazione
  del commento di render.ts è affidata al Task 2 (stesso file).
Task 2: minor (deferred): projectDir con slash finale — comportamento corretto, non testato.
Task 2: minor (deferred): path esattamente uguale a projectDir → '.' — ragionevole, non specificato né testato.
Task 2: minor (deferred): HOME assente o vuota — corretto (!base intercetta), non testato.
Task 2: minor (deferred): maxLen <= 0 rompe la garanzia "output <= maxLen" (maxLen=0 → 37 char).
Task 2: minor (deferred): descrizioni di alcuni test tradotte in inglese sgrammaticato.
Task 2: fix round 1/5 dispatched (2 Important: base vuota fa match su ogni path assoluto; ramo di elisione finale non coperto).
Task 2: fix round 1/5 (2 addressed a lettura, 0 verificati; commit 0a99ffe).
  Il fix corregge la guardia con `if (!b) return false;` e aggiunge 3 test.
  Ispezionato a lettura: corretto. NON eseguito: l'ambiente ha perso la
  capacità di lanciare node (Tool permission request failed / Stream closed),
  quindi né implementatore né controller hanno potuto chiudere il gate.
Task 2: BLOCKED — nessuna evidenza di test. Non è un difetto del codice né
  dell'implementatore: è l'ambiente. La re-review mirata NON è stata dispatchata,
  perché il contratto richiede test+comando+output nel report del fix e mancano
  tutti e tre. Prossima sessione: esegui il gate, atteso 392/0; se verde,
  dispatcha la re-review mirata su 64467b9..0a99ffe e poi chiudi il Task 2.
STOP CONTROLLER: esecuzione sospesa al Task 2. Task 3-11 non iniziati.
Task 2: gate ESEGUITO dal controller (node tornato disponibile): typecheck OK,
  392 test, 0 fallimenti. Il debito di verifica è chiuso.
Task 2: fix round 1/5 (2 addressed, 0 open; commits 3da0402..0a99ffe). Re-review
  mirata: entrambi ADDRESSED, nessuna rottura nuova.
Task 2: complete (commits 64467b9..0a99ffe, review clean, 392 test 0 fallimenti)
Task 3: complete (commits bcc2670..003aeee, review clean, 409 test 0 fallimenti)
Task 3: minor (deferred): casi limite corretti ma non asseriti — mcp__soloserver
  senza secondo __, WebFetch con url malformato, TodoWrite con todos assente/
  vuoto/non-oggetto, Read con solo offset o solo limit, renderToolLine con HTML
  dentro `target` (solo `detail` è testato).
Task 3: minor (deferred): report dell'implementatore dichiara 18 test nuovi, ne
  ha aggiunti 17 (13+4). Totale 409 e baseline 392 corretti, sbagliata la
  ripartizione.
Task 3: minor (deferred): messaggio di commit nominale invece che imperativo
  (ereditato dal brief, che proponeva una frase nominale).
Task 4: primo tentativo ABORTITO — il subagent è stato terminato dal limite di
  sessione dopo 7 tool use. Aveva rimosso summarize() da src/ollama.ts (37 righe)
  senza committare, lasciando il tree incoerente (bot/telegram.ts chiamava ancora
  quel metodo → typecheck rotto). Ripristinato con `git checkout -- src/ollama.ts`.
  Stato verificato dopo il ripristino: HEAD 003aeee, tree pulito, typecheck OK,
  409 test 0 fallimenti. Nessun lavoro perso: la rimozione è 37 righe, la rifà
  il tentativo successivo.
