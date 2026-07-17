import { appendAudit, createAuditLogFromEvents, type AuditLog } from './auditLog.js';
import { createCodexRunner, type SessionRunner } from './codexRunner.js';
import { denyDeviceBridge } from './deviceBridgePolicy.js';
import { createRunnerIntro, createStreamEvent } from './mockRunner.js';
import { addStreamEvents, createSessionStoreFromState, getOwnedSession, type SessionStore } from './sessionStore.js';
import {
  createJsonFilePersistence,
  serializeState,
  type StatePersistence,
} from './statePersistence.js';
import { getApprovedWorkspaces, resolveWorkspaceForUser } from './workspacePolicy.js';
import {
  firstMilestoneGates,
  type CreateSessionRequest,
  type RoadexBootstrap,
  type RoadexSession,
  type SessionRequest,
  type SessionResponse,
  type StreamEvent,
  type UserProfile,
  type CancelSessionResponse,
  type PromptAcceptedResponse,
} from '../shared/sessionContracts.js';

export type RoadexState = {
  sessions: SessionStore;
  audit: AuditLog;
  runner: SessionRunner;
  persistence: StatePersistence;
  activeRuns: Map<string, AbortController>;
  maxActiveRuns: number;
};

export function createInitialState(
  runner: SessionRunner = createCodexRunner(),
  persistence: StatePersistence = createJsonFilePersistence(),
): RoadexState {
  const persisted = persistence.load();
  return {
    sessions: createSessionStoreFromState({
      sessions: persisted.sessions,
      streamEvents: persisted.streamEvents,
    }),
    audit: createAuditLogFromEvents(persisted.auditEvents),
    runner,
    persistence,
    activeRuns: new Map(),
    maxActiveRuns: Number(process.env.ROADEX_MAX_ACTIVE_RUNS ?? 2),
  };
}

export async function bootstrap(state: RoadexState, user: UserProfile): Promise<RoadexBootstrap> {
  const userSessions = state.sessions.sessions.filter(
    (session) => session.userId === user.id && session.lifecycle !== 'closed',
  );
  if (userSessions.length === 0) {
    const defaultWorkspace = getApprovedWorkspaces()[0];
    if (defaultWorkspace) {
      await createSessionFromApi(state, user, { workspaceId: defaultWorkspace.id });
    }
  }
  return {
    user,
    workspaces: getApprovedWorkspaces(),
    sessions: state.sessions.sessions.filter(
      (session) => session.userId === user.id && session.lifecycle !== 'closed',
    ),
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
    saveState(state);
    return Promise.resolve(deny('workspace', workspaceDecision.reason));
  }

  if (request.requestedDeviceBridge) {
    const denied = denyDeviceBridge(state.audit, user);
    if (denied.ok) {
      saveState(state);
      return Promise.resolve(deny('device-bridge', 'Client device bridge is not available.'));
    }
    saveState(state);
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
    saveState(state);
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
  saveState(state);

  return Promise.resolve({ ok: true, session });
}

export function submitPrompt(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  prompt: string,
): PromptAcceptedResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || session.lifecycle === 'closed' || session.lifecycle === 'blocked' || session.lifecycle === 'streaming') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Session is unavailable to this user.');
    saveState(state);
    return undefined;
  }
  if (state.activeRuns.size >= state.maxActiveRuns) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Runner concurrency limit reached.');
    saveState(state);
    return undefined;
  }

  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Prompt cannot be empty.');
    saveState(state);
    return undefined;
  }
  if (cleanPrompt.length > 16_000) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Prompt exceeds server limit.');
    saveState(state);
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
  const controller = new AbortController();
  state.activeRuns.set(session.id, controller);
  void state.runner
    .runPrompt({
      session,
      prompt: cleanPrompt,
      signal: controller.signal,
      onEvent: (event) => {
        addStreamEvents(state.sessions, [event]);
        saveState(state);
      },
    })
    .then((result) => {
      if (result.ok) {
        session.lifecycle = 'ready';
        appendAudit(state.audit, user, 'session.runner_complete', sessionId, 'allowed', 'Codex runner completed.');
      } else if (result.reason === 'runner_cancelled') {
        session.lifecycle = 'ready';
        appendAudit(state.audit, user, 'session.cancel', sessionId, 'allowed', 'Codex runner was cancelled.');
      } else {
        session.lifecycle = 'blocked';
        appendAudit(state.audit, user, 'session.runner_failed', sessionId, 'denied', result.reason);
      }
    })
    .catch((error: unknown) => {
      session.lifecycle = 'blocked';
      appendAudit(
        state.audit,
        user,
        'session.runner_failed',
        sessionId,
        'denied',
        error instanceof Error ? error.message : 'runner_exception',
      );
    })
    .finally(() => {
      state.activeRuns.delete(session.id);
      saveState(state);
    });
  saveState(state);

  return { accepted: true, auditEvent: started };
}

export function cancelSessionRun(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): CancelSessionResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  const activeRun = state.activeRuns.get(sessionId);
  if (!session || !activeRun) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'No active runner is available to cancel.');
    saveState(state);
    return undefined;
  }

  activeRun.abort();
  const auditEvent = appendAudit(state.audit, user, 'session.cancel', sessionId, 'allowed', 'Cancel requested.');
  saveState(state);
  return { cancelled: true, auditEvent };
}

export function streamEventsForSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): StreamEvent[] | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || session.lifecycle === 'closed') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'SSE stream denied.');
    saveState(state);
    return undefined;
  }

  appendAudit(state.audit, user, 'session.stream_open', sessionId, 'allowed', 'Opened scoped SSE stream.');
  saveState(state);
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

function saveState(state: RoadexState): void {
  if (state.audit.events.length > 500) {
    state.audit.events.splice(0, state.audit.events.length - 500);
  }
  state.persistence.save(serializeState({
    sessions: state.sessions.sessions,
    streamEvents: state.sessions.streamEvents,
    auditEvents: state.audit.events,
  }));
}
