import { appendAudit, createAuditLog, type AuditLog } from './auditLog.js';
import { denyDeviceBridge } from './deviceBridgePolicy.js';
import { createPromptResponse, createRunnerIntro } from './mockRunner.js';
import { addStreamEvents, createSessionStore, getOwnedSession, type SessionStore } from './sessionStore.js';
import { approvedWorkspaces, resolveWorkspaceForUser } from './workspacePolicy.js';
import {
  firstMilestoneGates,
  type AuditEvent,
  type CreateSessionRequest,
  type RoadexBootstrap,
  type RoadexSession,
  type SessionRequest,
  type SessionResponse,
  type StreamEvent,
  type UserProfile,
} from '../shared/sessionContracts.js';

export type RoadexState = {
  sessions: SessionStore;
  audit: AuditLog;
};

export function createInitialState(): RoadexState {
  return {
    sessions: createSessionStore(),
    audit: createAuditLog(),
  };
}

export function bootstrap(state: RoadexState, user: UserProfile): RoadexBootstrap {
  const response = createSessionFromApi(state, user, { workspaceId: 'roadex' });
  return {
    user,
    workspaces: approvedWorkspaces,
    sessions: response.ok ? [response.session] : [],
    auditEvents: state.audit.events.slice(-8).reverse(),
    streamPreview: state.sessions.streamEvents.slice(-8),
  };
}

export function createSessionFromApi(
  state: RoadexState,
  user: UserProfile,
  request: CreateSessionRequest,
): SessionResponse {
  const workspaceDecision = resolveWorkspaceForUser(user, request.workspaceId);
  if (!workspaceDecision.ok) {
    appendAudit(state.audit, user, 'security.denied', 'workspace', 'denied', workspaceDecision.reason);
    return deny('workspace', workspaceDecision.reason);
  }

  if (request.requestedDeviceBridge) {
    const denied = denyDeviceBridge(state.audit, user);
    if (denied.ok) {
      return deny('device-bridge', 'Client device bridge is not available.');
    }
    return deny(denied.gate, denied.reason);
  }

  const response = createMockSession({
    userId: user.id,
    workspace: workspaceDecision.workspace,
  });

  if (!response.ok) {
    appendAudit(state.audit, user, 'security.denied', response.gate, 'denied', response.reason);
    return response;
  }

  const existing = getOwnedSession(state.sessions, user.id, response.session.id);
  if (existing) {
    appendAudit(state.audit, user, 'session.attach', existing.id, 'allowed', 'Attached existing mock session.');
    return { ok: true, session: existing };
  }

  state.sessions.sessions.push(response.session);
  addStreamEvents(state.sessions, createRunnerIntro(response.session.id));
  appendAudit(
    state.audit,
    user,
    'session.create',
    response.session.id,
    'allowed',
    `Created mock session for ${workspaceDecision.workspace.name}.`,
  );

  return { ok: true, session: response.session };
}

export function submitPrompt(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  prompt: string,
): { events: StreamEvent[]; auditEvent: AuditEvent } | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || session.lifecycle === 'closed' || session.lifecycle === 'blocked') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Session is unavailable to this user.');
    return undefined;
  }

  const events = createPromptResponse(session.id, prompt);
  addStreamEvents(state.sessions, events);
  const auditEvent = appendAudit(
    state.audit,
    user,
    'session.prompt',
    sessionId,
    'allowed',
    'Accepted prompt metadata for mock runner.',
  );

  return { events, auditEvent };
}

export function streamEventsForSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): StreamEvent[] | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || session.lifecycle === 'closed' || session.lifecycle === 'blocked') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'SSE stream denied.');
    return undefined;
  }

  appendAudit(state.audit, user, 'session.stream_open', sessionId, 'allowed', 'Opened scoped SSE stream.');
  return state.sessions.streamEvents.filter((event) => event.sessionId === sessionId);
}

export function createMockSession(request: SessionRequest): SessionResponse {
  if (!request.userId) {
    return deny('auth', 'Authentication is required before a Roadex session can be created.');
  }

  if (request.requestedDeviceBridge) {
    return deny('device-bridge', 'Client device bridge is disabled until the core portal passes review.');
  }

  const session: RoadexSession = {
    id: `mock-${request.workspace.id}`,
    userId: request.userId,
    workspace: request.workspace,
    lifecycle: 'ready',
    runnerMode: 'mock',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: firstMilestoneGates.map((gate) => ({
      ...gate,
      state: gate.id === 'device-bridge' ? 'deferred' : 'passed',
    })),
  };

  return { ok: true, session };
}

function deny(gate: string, reason: string): SessionResponse {
  return {
    ok: false,
    gate,
    reason,
  };
}
