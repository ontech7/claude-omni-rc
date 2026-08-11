import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Bus } from '../bus.js';
import { newEventId } from '../bus.js';
import { log } from '../log.js';
import type { Config } from '../config.js';
import type { Session, SessionStatus } from '../types.js';
import type { SessionManager } from './manager.js';
import {
  TranscriptTail,
  resolveTranscriptDir,
  newestTranscriptFile,
  findTranscriptFile,
  transcriptSessionId,
  peekTranscriptState,
  type TranscriptEvent,
} from './transcript.js';

export interface TranscriptWatcherDeps {
  config: Config;
  manager: SessionManager;
  bus: Bus;
  now?: () => number; // orologio iniettabile: la regola della finestra di grazia
                       // confronta con l'istante reale, non solo con le mtime,
                       // e i test devono poterlo simulare senza sleep reali.
}

// Finestra di grazia per il ramo "cambio di file" di un binding già vivo: un
// transcript diverso, comparso nella stessa dir, soppianta quello legato solo
// se il legato è DAVVERO silenzioso da almeno questo margine (vedi `supplants`
// in pollSession). Sotto la finestra è rumore (un subagent che scrive nella
// stessa dir di progetto mentre la nostra sessione lavora ancora); oltre, è
// probabilmente una rotazione vera — la sessione CLI è ripartita in un file
// nuovo e quello vecchio ha smesso di crescere. È un'euristica, può sbagliare
// (un subagent può scrivere per minuti mentre noi siamo fermi in attesa di una
// risposta umana): per questo lo switch, quando c'è, non deve MAI distruggere
// lo stato di lettura del file lasciato — vedi `tailFor`.
export const TRANSCRIPT_SWITCH_GRACE_MS = 60_000;

// Per ogni sessione terminale tracciata risolve il transcript del CLI
// (`~/.claude/projects/<progetto>/<sessione>.jsonl`), ne fa tail e re-emette i
// messaggi assistant/user come chat sul bus — lo stesso percorso usato dalle
// sessioni headless. Lo stato della sessione (working / in attesa dell'umano)
// viene dedotto dal transcript e scritto sul manager.
//
// Niente filtro sul modello: le sessioni terminali arrivano qui SOLO dal
// TmuxWatcher (nome `claude:*` + comando non-shell), quindi sono già "nostre" —
// lanciate con `ollama launch claude`. Il nome del modello nel transcript non
// distingue una sessione Ollama da una Anthropic-hosted (un modello `claude-*`
// può essere servito dal proxy Ollama locale) e un filtro lì scarterebbe
// proprio le sessioni più comuni.
export class TranscriptWatcher {
  private timer?: NodeJS.Timeout;
  // sessionId -> (file -> tail). Per sessione, non un solo tail globale: un
  // rebinding (giusto o sbagliato che sia) NON deve più distruggere lo stato
  // di lettura di un file già visto — vedi `tailFor`.
  private tails = new Map<string, Map<string, TranscriptTail>>();
  // Quanti file diversi restano "caldi" in cache per sessione: abbastanza per
  // il legato più un candidato o due, non tanti da accumulare senza limite in
  // una dir di progetto affollata di subagent.
  private static readonly MAX_TAILS_PER_SESSION = 4;
  // Un singolo TranscriptTail.poll() legge al più 1MB: per svuotare davvero un
  // backlog più grande (coda del vecchio file, o candidato pinnato da tempo)
  // serve un loop. Il cap sulle iterazioni è solo una sicurezza contro un file
  // patologico che continua a crescere più in fretta di quanto riusciamo a
  // leggerlo — non un limite che ci si aspetta di toccare in pratica.
  private static readonly MAX_DRAIN_READS = 200;

  constructor(private deps: TranscriptWatcherDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.config.pollIntervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (!this.deps.manager.isArmed()) return;
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal') continue;
      try {
        this.pollSession(s);
      } catch { /* una sessione non deve far cadere le altre */ }
    }
  }

  private mtimeOf(path: string): number | undefined {
    try { return statSync(path).mtimeMs; } catch { return undefined; }
  }

  // Ottiene il tail di un file per una sessione, riusando l'OGGETTO esistente
  // se questa sessione l'ha già visto (non solo il suo offset: il
  // TranscriptParser porta con sé anche il dedupe seenText/seenTool/seenError,
  // quindi un rientro su un file dopo che il binding è stato altrove riprende
  // esattamente da dove eravamo, senza perdere né duplicare nulla — è la
  // seconda barriera oltre all'offset). "Mai visto prima" (per questa
  // sessione), che si tratti della prima adozione o di un candidato incontrato
  // per la prima volta, resta invece EOF: questo progetto non rigioca mai la
  // storia quando un file viene tailato per la prima volta.
  private tailFor(sessionId: string, file: string): { tail: TranscriptTail; isNew: boolean } {
    let bySession = this.tails.get(sessionId);
    if (!bySession) { bySession = new Map(); this.tails.set(sessionId, bySession); }
    const existing = bySession.get(file);
    if (existing) {
      bySession.delete(file); // touch LRU: lo sposta in fondo (più recente)
      bySession.set(file, existing);
      return { tail: existing, isNew: false };
    }
    const tail = new TranscriptTail(file); // startAtEnd di default: mai visto → EOF
    bySession.set(file, tail);
    while (bySession.size > TranscriptWatcher.MAX_TAILS_PER_SESSION) {
      const lru = bySession.keys().next().value;
      if (lru === undefined) break;
      bySession.delete(lru);
    }
    return { tail, isNew: true };
  }

  // Legge un tail finché ci sono cambiamenti (loop, non un singolo poll: vedi
  // il commento su MAX_DRAIN_READS) ed emette tutti gli eventi trovati.
  private drainTail(s: Session, tail: TranscriptTail): void {
    let reads = 0;
    while (tail.hasChanges() && reads < TranscriptWatcher.MAX_DRAIN_READS) {
      const { events, state } = tail.poll();
      for (const ev of events) this.emit(s, ev);
      this.applyState(s, state);
      reads++;
    }
  }

  private pollSession(s: Session): void {
    const { config, manager } = this.deps;
    let file = s.transcriptFile;

    // Il path registrato è sparito: il CLI può aver spostato la sessione (es. in
    // un git worktree) e il transcript ora vive in un'altra dir di projectsDir.
    // Lo cerchiamo per basename prima di ripiegare sul "più recente" della dir
    // registrata, che potrebbe appartenere a un'ALTRA sessione.
    if (file && !existsSync(file)) {
      const relocated = findTranscriptFile(config.projectsDir, basename(file));
      if (relocated) {
        const previous = file;
        file = relocated;
        log().info('transcript bound', { sessionId: s.id, previous, next: file, reason: 'relocated-missing-file' });
        manager.setTranscriptFile(s.id, file);
        manager.persist();
      } else {
        // Non è da nessuna parte: lo registriamo. Se anche il fallback sotto
        // (adozione del "più recente") scarta ogni candidato, il poll altrimenti
        // finirebbe senza aver scritto NULLA — la stessa invisibilità che ha
        // nascosto per settimane la causa di questo bug.
        log().debug('transcript unbound', { sessionId: s.id, previous: file, reason: 'missing-not-relocated' });
        file = undefined;
      }
    }

    // Binding stale: il tmux-watcher ha aggiornato projectDir al worktree (cwd
    // del processo claude) ma il binding è ancora nella dir precedente — la
    // sessione si è spostata e il transcript va ri-scoperto nella dir nuova.
    // Il flag `.claude/worktrees` evita di scartare il binding quando più
    // sessioni condividono legittimamente la stessa dir di progetto.
    const resolvedDir = resolveTranscriptDir(config.projectsDir, s.projectDir);
    if (file && existsSync(file) && resolvedDir && dirname(file) !== resolvedDir && s.projectDir.includes('.claude/worktrees')) {
      log().info('transcript bound', { sessionId: s.id, previous: file, next: undefined, reason: 'stale-worktree-binding' });
      manager.setTranscriptFile(s.id, undefined);
      file = undefined;
    }

    if (!file || !existsSync(file)) {
      // Nessun transcript (ancora): il più recente nella dir del project registrato.
      const dir = resolveTranscriptDir(config.projectsDir, s.projectDir);
      const newest = dir ? newestTranscriptFile(dir) : undefined;
      if (!newest) return; // niente transcript → sessione screen-only (via /view)
      // una sessione ancora senza transcript non deve adottare quello di una
      // sessione PRECEDENTE: aspetta il file suo, che è più recente della
      // creazione della sessione (altrimenti mostrerebbe storia/status altrui).
      if (!file && s.createdAt) {
        const after = Date.parse(s.createdAt);
        if (!Number.isNaN(after)) {
          try {
            if (statSync(newest).mtimeMs < after) return;
          } catch {
            return;
          }
        }
      }
      // Guardia anti-adozione sbagliata: se la sessione AVEVA un transcript che è
      // sparito (e non è stato ritrovato altrove), il "più recente" qui può essere
      // di un'altra istanza → confronta l'id prima di adottarlo.
      const expectedId = s.claudeSessionId ?? (s.transcriptFile ? basename(s.transcriptFile).replace(/\.jsonl$/, '') : undefined);
      if (expectedId) {
        const nid = transcriptSessionId(newest);
        if (nid && nid !== expectedId) return;
      }
      log().info('transcript bound', { sessionId: s.id, previous: undefined, next: newest, reason: 'first-adoption' });
      file = newest;
      manager.setTranscriptFile(s.id, file);
      manager.persist(); // il binding sopravvive al riavvio del daemon
    } else {
      // Transcript valido: se nella SUA dir è comparso un file più recente NON lo
      // seguiamo ciecamente — quella dir contiene anche i transcript dei subagent
      // (Task, review, …), che sono sessioni diverse scritte nello stesso istante
      // in cui la nostra sta lavorando: seguirli è come inseguire rumore.
      // Una rotazione VERA (la sessione CLI riparte in un file nuovo, es. dopo
      // /clear) si riconosce perché il vecchio file smette DAVVERO di crescere —
      // vedi `boundIsQuiet`/`isNewer` sotto per la regola esatta.
      const newest = newestTranscriptFile(dirname(file));
      if (newest && newest !== file) {
        // Pinniamo il candidato al PRIMO avvistamento, PRIMA di valutare
        // qualsiasi altra cosa (compreso se il legato è già silenzioso
        // abbastanza da farlo vincere SUBITO). Se aspettassimo di sapere se
        // vince (come nel giro precedente di questo fix, che pinnava solo nel
        // ramo "non vince ancora"), il caso in cui candidato-scoperto e
        // candidato-promosso coincidono sullo stesso poll — tutt'altro che raro:
        // è la forma normale di una rotazione quando il file legato era già
        // fermo da prima che il nuovo comparisse — non avrebbe mai attraversato
        // quel ramo, e il primo tail per lui nascerebbe solo più tardi, dentro
        // la chiusura di pollSession più sotto. Pinnarlo qui rende "un tail dal
        // primo avvistamento" una garanzia strutturale, non un effetto
        // collaterale implicito di un altro punto del codice — e vale anche se
        // il controllo sul file legato qui sotto si ferma per un errore
        // transitorio (vedi il ramo `currentMtime === undefined &&
        // existsSync(file)`), che altrimenti avrebbe impedito il pin del tutto.
        this.tailFor(s.id, newest);

        const currentMtime = this.mtimeOf(file);
        if (currentMtime === undefined && existsSync(file)) {
          // statSync è appena fallito ma existsSync conferma che il file c'è
          // ancora: più probabile un errore transitorio (EMFILE, una race) che
          // una sparizione reale. Non decidiamo lo switch alla cieca — il
          // binding resta quello di prima, si riprova al prossimo poll.
        } else {
          const gone = currentMtime === undefined; // existsSync l'ha appena confermato: davvero sparito
          const newestMtime = this.mtimeOf(newest);
          const now = this.now();
          // "Il legato smette di crescere" = silenzio VERO rispetto a ORA, non
          // solo rispetto al candidato — altrimenti un file con mtime nel futuro
          // (un transcript ripristinato, copiato, o toccato da un tool) supera la
          // guardia all'istante. E il candidato deve essere davvero più recente
          // del legato, non semplicemente il legato più vecchio del candidato.
          const boundIsQuiet = gone || now - currentMtime! >= TRANSCRIPT_SWITCH_GRACE_MS;
          const isNewer = gone || (newestMtime !== undefined && newestMtime > currentMtime!);
          const supplants = newestMtime !== undefined && boundIsQuiet && isNewer;
          if (supplants) {
            const previous = file;
            // Cambio di file (giusto o sbagliato che sia): prima di spostare il
            // binding, svuotiamo la coda residua del vecchio file — se esiste un
            // suo tail — ed emettiamo i suoi eventi. PRIMA di riassegnare `file`,
            // così gli eventi del file vecchio raggiungono il bus prima di
            // quelli del nuovo e la cronologia arriva in ordine su Telegram.
            // Il tail del vecchio file NON viene distrutto (resta in cache, per
            // sessione+file): se il binding tornerà su di esso, riprenderà da
            // qui esattamente, non da un nuovo EOF.
            const oldTail = this.tails.get(s.id)?.get(previous);
            if (oldTail) this.drainTail(s, oldTail);
            file = newest;
            log().info('transcript bound', { sessionId: s.id, previous, next: file, reason: 'file-switch' });
            manager.setTranscriptFile(s.id, file);
            manager.persist();
          }
        }
      }
    }

    const { tail, isNew } = this.tailFor(s.id, file);
    if (isNew) {
      // mai tailato prima per questa sessione (prima adozione, o qualunque
      // altro file incontrato per la prima volta): nessun replay della storia,
      // stato iniziale dall'ultima riga già scritta. Salta un giro di poll: il
      // successivo recupera quanto scritto da qui in avanti.
      this.applyState(s, peekTranscriptState(file));
      return;
    }
    if (!tail.hasChanges()) {
      this.applyState(s, tail.parser.state);
      return;
    }
    this.drainTail(s, tail);
  }

  private emit(s: Session, ev: TranscriptEvent): void {
    const { bus, manager } = this.deps;
    const eventId = newEventId();
    manager.touch(s.id);
    if (ev.type === 'prompt') {
      manager.setStatus(s.id, 'awaiting-input');
      log().info('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'prompt', questions: ev.questions.length });
      bus.emit({ type: 'session.prompt', sessionId: s.id, questions: ev.questions, eventId });
      return;
    }
    if (ev.type === 'error') {
      log().warn('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'error', message: ev.message });
      bus.emit({ type: 'session.error', sessionId: s.id, message: ev.message, eventId });
      return;
    }
    if (ev.type === 'text') {
      log().info('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'text', role: ev.role, chars: ev.text.length });
      bus.emit({ type: 'session.text', sessionId: s.id, role: ev.role, text: ev.text, eventId });
      return;
    }
    manager.setStatus(s.id, 'running');
    if (ev.kind === 'tool_use') {
      // kind: 'tool' allinea il campo log al vocabolario del bot (GateKind): un
      // solo eventId, un solo `kind`, per legare l'emissione allo scarto/consegna
      // nel filtro dei log senza dover interrogare due valori diversi. toolUseId
      // e isError (sotto) distinguono comunque una tool_use da un tool_result.
      log().info('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'tool', toolName: ev.name, toolUseId: ev.id });
      bus.emit({
        type: 'session.tool', sessionId: s.id, toolName: ev.name, kind: 'tool_use',
        toolUseId: ev.id, input: (ev.input ?? {}) as Record<string, unknown>, eventId,
      });
      return;
    }
    log().debug('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'tool', toolName: ev.name, toolUseId: ev.id, isError: ev.isError });
    bus.emit({
      type: 'session.tool', sessionId: s.id, toolName: ev.name, kind: 'tool_result',
      toolUseId: ev.id, result: ev.result, isError: ev.isError, eventId,
    });
  }

  private applyState(s: Session, state: string): void {
    const status: SessionStatus = state === 'awaiting' ? 'awaiting-input' : state === 'working' ? 'running' : s.status;
    if (status !== s.status) this.deps.manager.setStatus(s.id, status);
  }
}
