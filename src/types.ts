// Effort di ragionamento dei modelli che lo supportano (Claude nativo). Le
// sessioni terminali lo scoprono dalla riga di comando (`--reasoning-effort`),
// le headless lo ricevono da /new --effort (default DEFAULT_EFFORT). 'max' è
// riservato a pochi modelli e non è esposto qui: si sceglie esplicitamente via CLI.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type SessionKind = 'headless' | 'terminal';
export type SessionStatus = 'idle' | 'running' | 'awaiting-input' | 'waiting-permission' | 'error' | 'stopped';

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  projectDir: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: 'auto' | 'standard'; // automode default: nessun prompt di permesso
  status: SessionStatus;
  claudeSessionId?: string;
  tmuxTarget?: string;
  transcriptFile?: string; // transcript del CLI risolto dal TranscriptWatcher
  lastActivity: string; // ISO
  createdAt: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: string;
}

// Domanda a scelta multipla fatta dal modello (tool AskUserQuestion del CLI),
// leggibile dal transcript per le sessioni terminali.
export interface PromptQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

// Risposta dell'utente a una domanda: una o più opzioni selezionate, oppure
// testo libero (l'opzione "Other" che il CLI aggiunge sempre automaticamente).
// `extraText` sulle opzioni copre il caso multi-select in cui l'utente ha
// togglato delle opzioni E ha scritto un testo libero: il CLI li registra
// entrambi (es. "A, custom text"), quindi vanno iniettati insieme.
export type PromptAnswer =
  | { kind: 'option'; labels: string[]; extraText?: string }
  | { kind: 'other'; text: string };

// Dialogo bloccante che il CLI chiede di renderizzare (request_user_dialog).
// `dialogKind` è una string union aperta: il CLI può aggiungerne di nuove senza
// bump di protocollo, quindi un kind sconosciuto va risposto con 'cancelled'.
export interface UserDialog {
  id: string;
  dialogKind: string;
  payload: Record<string, unknown>;
  toolUseID?: string;
}

export type BusEvent =
  | { type: 'session.updated'; sessionId: string }
  | { type: 'session.text'; sessionId: string; role: 'user' | 'assistant'; text: string; eventId?: string }
  | {
      type: 'session.prompt';
      sessionId: string;
      questions: PromptQuestion[];
      eventId?: string;
      // Task 8: id della tool_use AskUserQuestion che ha generato la domanda —
      // chiave di deduplica primaria fra la copia dell'hook e quella (più
      // tardiva) del transcript, che portano lo stesso toolUseId.
      toolUseId?: string;
      // Da dove arriva questa copia: l'hook scatta prima che il CLI apra il
      // menu (in tempo per Telegram), il transcript solo quando il turno si
      // sblocca (l'utente ha già risposto al terminale). Serve al bot per il
      // contesto del pane (solo 'hook') e alla diagnosi nel log.
      source?: 'transcript' | 'hook';
    }
  | {
      type: 'session.tool';
      sessionId: string;
      toolName: string;
      kind: 'tool_use' | 'tool_result';
      toolUseId?: string;
      input?: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
      eventId?: string;
    }
  | { type: 'session.permission'; permission: PermissionRequest }
  | { type: 'session.dialog'; sessionId: string; dialog: UserDialog }
  | { type: 'session.result'; sessionId: string; result: string; isError: boolean }
  | { type: 'session.error'; sessionId: string; message: string; eventId?: string };
