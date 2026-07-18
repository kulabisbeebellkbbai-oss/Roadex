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
import { canAccessManagedCodexProjects, getApprovedWorkspaces, resolveWorkspaceForUser } from './workspacePolicy.js';
import { loadManagedCodexThreads } from './codexProjectsRegistry.js';
import {
  firstMilestoneGates,
  type CreateSessionRequest,
  type ManagedThreadClaim,
  type RoadexBootstrap,
  type RoadexSession,
  type SessionRequest,
  type SessionResponse,
  type StreamEvent,
  type UserProfile,
  type CancelSessionResponse,
  type CloseSessionResponse,
  type ReopenSessionResponse,
  type PromptAcceptedResponse,
} from '../shared/sessionContracts.js';

export type RoadexState = {
  sessions: SessionStore;
  audit: AuditLog;
  runner: SessionRunner;
  persistence: StatePersistence;
  activeRuns: Map<string, AbortController>;
  cancelAttempts: Map<string, number>;
  streamSubscribers: Map<string, Set<StreamSubscriber>>;
  maxStreamSubscribersPerSession: number;
  maxActiveRuns: number;
  maxActiveSessionsPerUser: number;
  managedThreadClaims: Map<string, ManagedThreadClaim>;
};

type StreamSubscriber = {
  user: UserProfile;
  onEvent: (event: StreamEvent) => void;
};

export function createInitialState(
  runner: SessionRunner = createCodexRunner(),
  persistence: StatePersistence = createJsonFilePersistence(),
): RoadexState {
  const persisted = persistence.load();
  const managedThreadClaims = new Map(persisted.managedThreadClaims.map((claim) => [claim.threadId, claim]));
  for (const session of persisted.sessions) {
    if (session.managedThreadId && !managedThreadClaims.has(session.managedThreadId)) {
      managedThreadClaims.set(session.managedThreadId, {
        threadId: session.managedThreadId,
        userId: session.userId,
        claimedAt: session.createdAt,
      });
    }
  }
  return {
    sessions: createSessionStoreFromState({
      sessions: persisted.sessions,
      streamEvents: persisted.streamEvents,
    }),
    audit: createAuditLogFromEvents(persisted.auditEvents),
    runner,
    persistence,
    activeRuns: new Map(),
    cancelAttempts: new Map(),
    streamSubscribers: new Map(),
    maxStreamSubscribersPerSession: readPositiveInteger(process.env.ROADEX_MAX_STREAMS_PER_SESSION, 4),
    maxActiveRuns: Number(process.env.ROADEX_MAX_ACTIVE_RUNS ?? 2),
    maxActiveSessionsPerUser: readPositiveInteger(process.env.ROADEX_MAX_ACTIVE_SESSIONS_PER_USER, 8),
    managedThreadClaims,
  };
}

export async function bootstrap(state: RoadexState, user: UserProfile): Promise<RoadexBootstrap> {
  let userSessions = state.sessions.sessions.filter((session) => isVisibleSessionForUser(state, session, user));
  const hasArchivedSessions = state.sessions.sessions.some(
    (session) => session.userId === user.id && session.lifecycle === 'closed',
  );
  if (userSessions.length === 0 && !hasArchivedSessions) {
    const defaultWorkspace = getApprovedWorkspaces(user)[0];
    if (defaultWorkspace) {
      await createSessionFromApi(state, user, { workspaceId: defaultWorkspace.id });
      userSessions = state.sessions.sessions.filter((session) => isVisibleSessionForUser(state, session, user));
    }
  }
  const visibleSessionIds = new Set(userSessions.map((session) => session.id));
  return {
    user,
    workspaces: getApprovedWorkspaces(user),
    sessions: userSessions,
    auditEvents: visibleAuditEvents(state.audit, user).slice(-8).reverse(),
    streamPreview: state.sessions.streamEvents.filter((event) => visibleSessionIds.has(event.sessionId)).slice(-8),
    managedThreads: canAccessManagedCodexProjects(user) ? safeManagedThreads(user) : [],
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

  const managedThread = request.managedThreadId ? findManagedThreadForUser(user, request.managedThreadId) : undefined;
  if (request.managedThreadId && !managedThread) {
    appendAudit(state.audit, user, 'security.denied', 'managed-thread', 'denied', 'Managed thread attach denied.');
    saveState(state);
    return Promise.resolve(deny('managed-thread', 'Managed Codex thread is unavailable.'));
  }
  if (
    managedThread &&
    (request.newThread === true ||
      managedThread.project.id !== workspaceDecision.workspace.id ||
      managedThread.project.root !== workspaceDecision.workspace.root)
  ) {
    appendAudit(state.audit, user, 'security.denied', 'managed-thread', 'denied', 'Managed thread project mismatch.');
    saveState(state);
    return Promise.resolve(deny('managed-thread', 'Managed Codex thread is unavailable.'));
  }
  if (managedThread) {
    const claim = state.managedThreadClaims.get(managedThread.id);
    if (claim && claim.userId !== user.id) {
      appendAudit(state.audit, user, 'security.denied', 'managed-thread', 'denied', 'Managed thread is already claimed.');
      saveState(state);
      return Promise.resolve(deny('managed-thread', 'Managed Codex thread is unavailable.'));
    }
  }

  const createNewThread = request.newThread === true;
  const existing = !createNewThread && state.sessions.sessions.find(
    (session) =>
      session.userId === user.id &&
      session.workspace.id === workspaceDecision.workspace.id &&
      isVisibleSession(session) &&
      (!managedThread || session.managedThreadId === managedThread.id),
  );
  if (existing) {
    touchSession(existing);
    appendAudit(state.audit, user, 'session.attach', existing.id, 'allowed', 'Attached existing Codex session.');
    saveState(state);
    return Promise.resolve({ ok: true, session: existing });
  }

  if (managedThread) {
    const archived = state.sessions.sessions.find(
      (session) => session.userId === user.id && session.managedThreadId === managedThread.id,
    );
    if (archived) {
      appendAudit(state.audit, user, 'security.denied', archived.id, 'denied', 'Managed thread is archived in Roadex.');
      saveState(state);
      return Promise.resolve(deny('managed-thread', 'Reopen the archived Roadex thread instead.'));
    }
  }

  if (activeSessionCountForUser(state, user.id) >= state.maxActiveSessionsPerUser) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      'session-limit',
      'denied',
      'New thread denied: active session limit reached.',
    );
    saveState(state);
    return Promise.resolve(deny('session-limit', 'Active thread limit reached. Archive a thread before creating another.'));
  }

  const session = state.runner.createSession({
    userId: user.id,
    workspace: workspaceDecision.workspace,
  });
  if (managedThread) {
    session.codexThreadId = managedThread.id;
    session.managedThreadId = managedThread.id;
    if (!state.managedThreadClaims.has(managedThread.id)) {
      state.managedThreadClaims.set(managedThread.id, {
        threadId: managedThread.id,
        userId: user.id,
        claimedAt: session.createdAt,
      });
    }
  }
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
    managedThread
      ? `Attached managed Codex thread for ${workspaceDecision.workspace.name}.`
      : `Created Codex session for ${workspaceDecision.workspace.name}.`,
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
  if (!session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle === 'closed' || session.lifecycle === 'blocked' || session.lifecycle === 'streaming') {
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
  touchSession(session);
  const started = appendAudit(
    state.audit,
    user,
    'session.prompt',
    sessionId,
    'allowed',
    'Accepted prompt for Codex runner.',
  );
  addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'user', cleanPrompt)]);
  const controller = new AbortController();
  state.activeRuns.set(session.id, controller);
  void state.runner
    .runPrompt({
      session,
      prompt: cleanPrompt,
      signal: controller.signal,
      onEvent: (event) => {
        addAndPublishStreamEvents(state, [event]);
      },
    })
    .then((result) => {
      if (session.lifecycle === 'closed') return;
      if (session.managedThreadId && result.codexThreadId && result.codexThreadId !== session.managedThreadId) {
        session.lifecycle = 'blocked';
        touchSession(session);
        appendAudit(
          state.audit,
          user,
          'security.denied',
          sessionId,
          'denied',
          'Managed Codex runner returned a mismatched thread identity.',
        );
        return;
      }
      updateCodexThreadId(session, result.codexThreadId);
      if (result.ok) {
        session.lifecycle = 'ready';
        touchSession(session);
        appendAudit(state.audit, user, 'session.runner_complete', sessionId, 'allowed', 'Codex runner completed.');
      } else if (result.reason === 'runner_cancelled') {
        session.lifecycle = 'ready';
        touchSession(session);
        appendAudit(state.audit, user, 'session.cancel', sessionId, 'allowed', 'Codex runner was cancelled.');
      } else {
        session.lifecycle = 'blocked';
        touchSession(session);
        appendAudit(state.audit, user, 'session.runner_failed', sessionId, 'denied', result.reason);
      }
    })
    .catch((error: unknown) => {
      if (session.lifecycle === 'closed') return;
      session.lifecycle = 'blocked';
      touchSession(session);
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

export function closeSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): CloseSessionResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session)) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Close denied: actor=${user.id} session=${sessionId} reason=session_not_owned_or_missing.`,
    );
    saveState(state);
    return undefined;
  }

  const activeRun = state.activeRuns.get(sessionId);
  activeRun?.abort();
  state.streamSubscribers.delete(sessionId);
  session.lifecycle = 'closed';
  touchSession(session);
  const auditEvent = appendAudit(
    state.audit,
    user,
    'session.close',
    sessionId,
    'allowed',
    `Closed session: actor=${user.id} session=${sessionId} active_runner=${Boolean(activeRun)} result=archived.`,
  );
  saveState(state);
  return { closed: true, auditEvent };
}

export function listArchivedSessions(state: RoadexState, user: UserProfile): RoadexSession[] {
  return state.sessions.sessions
    .filter((session) => session.userId === user.id && session.lifecycle === 'closed' && isManagedSessionAuthorized(state, user, session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function reopenSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): ReopenSessionResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session)) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Reopen denied: actor=${user.id} session=${sessionId} reason=session_not_owned_or_missing.`,
    );
    saveState(state);
    return undefined;
  }
  if (session.lifecycle !== 'closed') {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Reopen denied: actor=${user.id} session=${sessionId} reason=session_not_closed.`,
    );
    saveState(state);
    return undefined;
  }
  if (state.activeRuns.has(sessionId)) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Reopen denied: actor=${user.id} session=${sessionId} reason=active_runner_present.`,
    );
    saveState(state);
    return undefined;
  }
  const workspaceDecision = resolveWorkspaceForUser(user, session.workspace.id);
  if (!workspaceDecision.ok || workspaceDecision.workspace.root !== session.workspace.root) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Reopen denied: actor=${user.id} session=${sessionId} reason=workspace_no_longer_approved.`,
    );
    saveState(state);
    return undefined;
  }
  if (activeSessionCountForUser(state, user.id) >= state.maxActiveSessionsPerUser) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Reopen denied: actor=${user.id} session=${sessionId} reason=active_session_limit_reached.`,
    );
    saveState(state);
    return {
      reopened: false,
      gate: 'session-limit',
      reason: 'Active thread limit reached. Archive a thread before reopening another.',
    };
  }
  session.lifecycle = 'ready';
  touchSession(session);
  const auditEvent = appendAudit(
    state.audit,
    user,
    'session.reopen',
    sessionId,
    'allowed',
    `Reopened session: actor=${user.id} session=${sessionId} result=ready.`,
  );
  saveState(state);
  return { reopened: true, session, auditEvent };
}

export function cancelSessionRun(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): CancelSessionResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session)) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Cancel denied: actor=${user.id} session=${sessionId} reason=session_not_owned_or_missing.`,
    );
    recordCancelAttempt(state, user, sessionId, 'session_not_owned_or_missing');
    saveState(state);
    return undefined;
  }

  const activeRun = state.activeRuns.get(sessionId);
  if (!activeRun) {
    const auditEvent = appendAudit(
      state.audit,
      user,
      'session.cancel',
      sessionId,
      'denied',
      `Cancel ignored: actor=${user.id} session=${sessionId} active_runner=false result=not_running.`,
    );
    recordCancelAttempt(state, user, sessionId, 'not_running');
    saveState(state);
    return { cancelled: false, status: 'not-running', auditEvent };
  }

  activeRun.abort();
  state.cancelAttempts.delete(cancelAttemptKey(user, sessionId));
  touchSession(session);
  const auditEvent = appendAudit(
    state.audit,
    user,
    'session.cancel',
    sessionId,
    'allowed',
    `Cancel requested: actor=${user.id} session=${sessionId} active_runner=true result=abort_signal_sent.`,
  );
  saveState(state);
  return { cancelled: true, status: 'cancel-requested', auditEvent };
}

export function streamEventsForSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): StreamEvent[] | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle === 'closed') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'SSE stream denied.');
    saveState(state);
    return undefined;
  }

  appendAudit(state.audit, user, 'session.stream_open', sessionId, 'allowed', 'Opened scoped SSE stream.');
  saveState(state);
  return state.sessions.streamEvents.filter((event) => event.sessionId === sessionId);
}

export function subscribeToSessionStream(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
): { snapshot: StreamEvent[]; isAuthorized: () => boolean; unsubscribe: () => void } | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle === 'closed') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'SSE stream denied.');
    saveState(state);
    return undefined;
  }

  const existingSubscribers = state.streamSubscribers.get(sessionId);
  if (existingSubscribers && existingSubscribers.size >= state.maxStreamSubscribersPerSession) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Live stream subscriber limit reached: actor=${user.id} session=${sessionId}.`,
    );
    saveState(state);
    return undefined;
  }

  appendAudit(state.audit, user, 'session.stream_open', sessionId, 'allowed', 'Opened scoped SSE stream.');
  saveState(state);
  const snapshot = state.sessions.streamEvents.filter((event) => event.sessionId === sessionId);

  const subscribers = state.streamSubscribers.get(sessionId) ?? new Set<StreamSubscriber>();
  const subscriber = { user: { ...user, roles: [...user.roles] }, onEvent };
  subscribers.add(subscriber);
  state.streamSubscribers.set(sessionId, subscribers);
  return {
    snapshot,
    isAuthorized() {
      if (isManagedSessionAuthorized(state, user, session)) return true;
      revokeManagedSessionAccess(state, session);
      return false;
    },
    unsubscribe() {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        state.streamSubscribers.delete(sessionId);
      }
    },
  };
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  state.persistence.save(serializeState({
    sessions: state.sessions.sessions,
    streamEvents: state.sessions.streamEvents,
    auditEvents: state.audit.events,
    managedThreadClaims: [...state.managedThreadClaims.values()],
  }));
}

function addAndPublishStreamEvents(state: RoadexState, events: StreamEvent[]): void {
  addStreamEvents(state.sessions, events);
  for (const event of events) {
    const subscribers = state.streamSubscribers.get(event.sessionId);
    if (!subscribers) continue;
    const session = state.sessions.sessions.find((candidate) => candidate.id === event.sessionId);
    for (const subscriber of subscribers) {
      if (!session || !isManagedSessionAuthorized(state, subscriber.user, session)) {
        subscribers.delete(subscriber);
        if (session) revokeManagedSessionAccess(state, session);
        continue;
      }
      subscriber.onEvent(event);
    }
    if (subscribers.size === 0) state.streamSubscribers.delete(event.sessionId);
  }
  saveState(state);
}

function recordCancelAttempt(state: RoadexState, user: UserProfile, sessionId: string, reason: string): void {
  const key = cancelAttemptKey(user, sessionId);
  const attempts = (state.cancelAttempts.get(key) ?? 0) + 1;
  state.cancelAttempts.set(key, attempts);
  if (attempts >= 3) {
    appendAudit(
      state.audit,
      user,
      'security.denied',
      sessionId,
      'denied',
      `Cancel alert: actor=${user.id} session=${sessionId} attempts=${attempts} reason=${reason}.`,
    );
  }
}

function cancelAttemptKey(user: UserProfile, sessionId: string): string {
  return `${user.id}:${sessionId}`;
}

function isVisibleSessionForUser(state: RoadexState, session: RoadexSession, user: UserProfile): boolean {
  return session.userId === user.id && isVisibleSession(session) && isManagedSessionAuthorized(state, user, session);
}

function isManagedSessionAuthorized(state: RoadexState, user: UserProfile, session: RoadexSession): boolean {
  if (!session.managedThreadId) return true;
  const claim = state.managedThreadClaims.get(session.managedThreadId);
  return claim?.userId === user.id && Boolean(findManagedThreadForUser(user, session.managedThreadId));
}

function revokeManagedSessionAccess(state: RoadexState, session: RoadexSession): void {
  if (!session.managedThreadId) return;
  state.activeRuns.get(session.id)?.abort();
  state.streamSubscribers.delete(session.id);
  saveState(state);
}

function isVisibleSession(session: RoadexSession): boolean {
  return session.lifecycle !== 'closed' && session.lifecycle !== 'blocked';
}

function activeSessionCountForUser(state: RoadexState, userId: string): number {
  return state.sessions.sessions.filter(
    (session) => session.userId === userId && isVisibleSession(session),
  ).length;
}

function safeManagedThreads(user: UserProfile) {
  try {
    const workspaces = getApprovedWorkspaces(user);
    return loadManagedCodexThreads().flatMap((thread) => {
      const workspace = workspaces.find((candidate) => candidate.root === thread.project.root);
      return workspace ? [{ ...thread, project: workspace }] : [];
    });
  } catch {
    return [];
  }
}

function findManagedThreadForUser(user: UserProfile, threadId: string) {
  if (!canAccessManagedCodexProjects(user)) return undefined;
  return safeManagedThreads(user).find((thread) => thread.id === threadId);
}

function touchSession(session: RoadexSession): void {
  session.updatedAt = new Date().toISOString();
}

function updateCodexThreadId(session: RoadexSession, codexThreadId: string | undefined): void {
  if (!codexThreadId || session.codexThreadId === codexThreadId) return;
  session.codexThreadId = codexThreadId;
  touchSession(session);
}

function visibleAuditEvents(audit: AuditLog, user: UserProfile) {
  if (user.roles.includes('admin') || user.roles.includes('security-reviewer')) {
    return audit.events;
  }
  return audit.events.filter((event) => event.actorId === user.id);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
