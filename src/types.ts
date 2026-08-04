export type SessionKind = 'headless' | 'terminal';
export type SessionStatus = 'idle' | 'running' | 'waiting-permission' | 'error' | 'stopped';

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  projectDir: string;
  model?: string;
  status: SessionStatus;
  claudeSessionId?: string;
  tmuxTarget?: string;
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

export type BusEvent =
  | { type: 'session.updated'; sessionId: string }
  | { type: 'session.text'; sessionId: string; role: 'user' | 'assistant'; text: string }
  | {
      type: 'session.tool';
      sessionId: string;
      toolName: string;
      kind: 'tool_use' | 'tool_result';
      toolUseId?: string;
      input?: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
    }
  | { type: 'session.permission'; permission: PermissionRequest }
  | { type: 'session.result'; sessionId: string; result: string; isError: boolean }
  | { type: 'session.error'; sessionId: string; message: string };
