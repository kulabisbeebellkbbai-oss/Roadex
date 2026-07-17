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

export type RoadexSession = {
  id: string;
  userId: string;
  workspace: WorkspaceRef;
  lifecycle: SessionLifecycle;
  runnerMode: 'mock' | 'codex';
  transport: 'sse' | 'websocket';
  deviceBridge: 'disabled' | 'review-required' | 'enabled';
  gates: SecurityGate[];
};

export type SessionRequest = {
  userId?: string;
  workspace: WorkspaceRef;
  requestedDeviceBridge?: boolean;
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
