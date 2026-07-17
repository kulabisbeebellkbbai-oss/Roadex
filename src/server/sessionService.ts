import { appendAudit, createAuditLog, type AuditLog } from './auditLog.js';
import { createCodexRunner, type SessionRunner } from './codexRunner.js';
import { denyDeviceBridge } from './deviceBridgePolicy.js';
import { createRunnerIntro, createStreamEvent } from './mockRunner.js';
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
  runner: SessionRunner;
};

export function createInitialState(runner: SessionRunner = createCodexRunner()): RoadexState {
  return {
    sessions: createSessionStore(),
    audit: createAuditLog(),
    runner,
  };
}

export async function bootstrap(state: RoadexState, user: UserProfile): Promise<RoadexBootstrap> {
  const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
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
): Promise<SessionResponse> {
  const workspaceDecision = resolveWorkspaceForUser(user, request.workspaceId);
  if (!workspaceDecision.ok) {
    appendAudit(state.audit, user, 'security.denied', 'workspace', 'denied', workspaceDecision.reason);
    return Promise.resolve(deny('workspace', workspaceDecision.reason));
  }

  if (request.requestedDeviceBridge) {
    const denied = denyDeviceBridge(state.audit, user);
    if (denied.ok) {
      return Promise.resolve(deny('device-bridge', 'Client device bridge is not available.'));
    }
    return Promise.resolve(deny(denied.gate, denied.reason));
  }

  const existing = state.sessions.sessions.find(
    (session) =>
      session.userId === user.id &&
      session.workspace.id === workspaceDecision.workspace.id &&
      session.lifecycle !== 'closed',
  );
  if (existing) {
    appendAudit(state.audit, user, 'session.attach', existing.id, 'allowed', 'Attached existing Codex session.');
    return Promise.resolve({ ok: true, session: existing });
  }

  const session = state.runner.createSession({
    userId: user.id,
    workspace: workspaceDecision.workspace,
  });
  state.sessions.sessions.push(session);
  addStreamEvents(state.sessions, [
    ...createRunnerIntro(session.id),
    createStreamEvent(session.id, 'system', 'Real Codex runner is enabled for prompts in this server workspace.'),
  ]);
  appendAudit(
    state.audit,
    user,
    'session.create',
    session.id,
    'allowed',
    `Created Codex session for ${workspaceDecision.workspace.name}.`,
  );

  return Promise.resolve({ ok: true, session });
}

export async function submitPrompt(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  prompt: string,
): Promise<{ events: StreamEvent[]; auditEvent: AuditEvent } | undefined> {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || session.lifecycle === 'closed' || session.lifecycle === 'blocked') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Session is unavailable to this user.');
    return undefined;
  }

  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Prompt cannot be empty.');
    return undefined;
  }
  if (cleanPrompt.length > 16_000) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Prompt exceeds server limit.');
    return undefined;
  }

  session.lifecycle = 'streaming';
  const started = appendAudit(
    state.audit,
    user,
    'session.prompt',
    sessionId,
    'allowed',
    'Accepted prompt for Codex runner.',
  );
  const result = await state.runner.runPrompt({ session, prompt: cleanPrompt });
  const events = result.events;
  addStreamEvents(state.sessions, events);
  if (result.ok) {
    session.lifecycle = 'ready';
    appendAudit(state.audit, user, 'session.runner_complete', sessionId, 'allowed', 'Codex runner completed.');
  } else {
    session.lifecycle = 'blocked';
    appendAudit(state.audit, user, 'session.runner_failed', sessionId, 'denied', result.reason);
  }

  return { events, auditEvent: started };
}

export function streamEventsForSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): StreamEvent[] | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || session.lifecycle === 'closed') {
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
