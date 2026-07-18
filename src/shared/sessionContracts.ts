export type SessionLifecycle =
  | 'pending'
  | 'ready'
  | 'streaming'
  | 'paused'
  | 'blocked'
  | 'closed';

export type SecurityGate = {
  id: string;
  label: string;
  state: 'required' | 'passed' | 'blocked' | 'deferred';
  description: string;
};

export type WorkspaceRef = {
  id: string;
  name: string;
  root: string;
};

export type UserProfile = {
  id: string;
  displayName: string;
  authMode: 'mock' | 'protected-gateway';
  roles: Array<'user' | 'admin' | 'security-reviewer'>;
};

export type AuditEvent = {
  id: string;
  at: string;
  actorId: string;
  action:
    | 'auth.mock_user_loaded'
    | 'session.create'
    | 'session.attach'
    | 'session.prompt'
    | 'session.runner_complete'
    | 'session.runner_failed'
    | 'session.cancel'
    | 'session.close'
    | 'session.reopen'
    | 'session.stream_open'
    | 'security.denied';
  resource: string;
  outcome: 'allowed' | 'denied';
  summary: string;
};

export type StreamEvent = {
  id: string;
  sessionId: string;
  kind: 'system' | 'assistant' | 'audit';
  message: string;
  at: string;
};

export type PromptAcceptedResponse = {
  accepted: true;
  auditEvent: AuditEvent;
};

export type CancelSessionResponse = {
  cancelled: boolean;
  status: 'cancel-requested' | 'not-running';
  auditEvent: AuditEvent;
};

export type CloseSessionResponse = {
  closed: true;
  auditEvent: AuditEvent;
};

export type ReopenSessionResponse = {
  reopened: true;
  session: RoadexSession;
  auditEvent: AuditEvent;
};

export type RoadexSession = {
  id: string;
  userId: string;
  workspace: WorkspaceRef;
  lifecycle: SessionLifecycle;
  runnerMode: 'mock' | 'codex';
  transport: 'sse' | 'websocket';
  deviceBridge: 'disabled' | 'review-required' | 'enabled';
  gates: SecurityGate[];
  createdAt: string;
  updatedAt: string;
  codexThreadId?: string;
};

export type SessionRequest = {
  userId?: string;
  workspace: WorkspaceRef;
  requestedDeviceBridge?: boolean;
};

export type CreateSessionRequest = {
  workspaceId: string;
  requestedDeviceBridge?: boolean;
};

export type RoadexBootstrap = {
  user: UserProfile;
  workspaces: WorkspaceRef[];
  sessions: RoadexSession[];
  auditEvents: AuditEvent[];
  streamPreview: StreamEvent[];
};

export type SessionResponse =
  | {
      ok: true;
      session: RoadexSession;
    }
  | {
      ok: false;
      reason: string;
      gate: string;
    };

export const firstMilestoneGates: SecurityGate[] = [
  {
    id: 'auth',
    label: 'Authenticated user',
    state: 'required',
    description: 'A verified user identity is required before creating a session.',
  },
  {
    id: 'workspace',
    label: 'Workspace scope',
    state: 'required',
    description: 'The workspace must be server-approved and bound to the user.',
  },
  {
    id: 'audit',
    label: 'Audit trail',
    state: 'required',
    description: 'Session lifecycle and sensitive decisions must be logged.',
  },
  {
    id: 'device-bridge',
    label: 'Client device bridge',
    state: 'deferred',
    description: 'USB and local peripherals stay disabled until security review.',
  },
];
