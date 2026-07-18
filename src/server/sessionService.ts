import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { appendAudit, createAuditLogFromEvents, type AuditLog } from './auditLog.js';
import { createCodexRunner, type SessionRunner } from './codexRunner.js';
import {
  denyDeviceBridge,
  deviceBridgeAuditHmacKey,
  deviceBridgeIdentityHmacKey,
  deviceBridgeMetadataRegistryEnabled,
  deviceBridgeRequestIntakeEnabled,
  getDeviceBridgePolicy,
} from './deviceBridgePolicy.js';
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
  type AuditEvent,
  type CancelSessionResponse,
  type CloseSessionResponse,
  type ReopenSessionResponse,
  type PromptAcceptedResponse,
} from '../shared/sessionContracts.js';
import type {
  DeviceArtifactMetadata,
  DeviceArtifactMetadataPublic,
  DeviceArtifactMetadataRegistrationPayload,
  DeviceBridgeApprovalRecord,
  DeviceBridgeMetadataResponse,
  DeviceBridgeOperationRecord,
  DeviceBridgeRequestPayload,
  DeviceBridgeRequestPublic,
  DeviceBridgeRequestRecord,
  DeviceBridgeRequestResponse,
  DeviceInventoryBindingPayload,
  DeviceInventoryBindingRecord,
  DeviceInventoryBindingResponse,
} from '../shared/deviceBridgeContracts.js';

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
  deviceArtifacts: Map<string, DeviceArtifactMetadata>;
  deviceBridgeRequests: Map<string, DeviceBridgeRequestRecord>;
  deviceBridgeApprovals: Map<string, DeviceBridgeApprovalRecord>;
  deviceBridgeOperations: Map<string, DeviceBridgeOperationRecord>;
  deviceInventoryBindings: Map<string, DeviceInventoryBindingRecord>;
};

type StreamSubscriber = {
  user: UserProfile;
  onEvent: (event: StreamEvent) => void;
};

type DeviceBridgeRequestGate =
  | 'auth'
  | 'audit'
  | 'device-bridge'
  | 'session'
  | 'workspace'
  | 'artifact'
  | 'inventory'
  | 'schema'
  | 'quota';

type DeviceBridgeMetadataGate =
  | 'auth'
  | 'audit'
  | 'device-bridge'
  | 'session'
  | 'workspace'
  | 'schema'
  | 'quota';

type DeviceInventoryBindingGate =
  | 'auth'
  | 'audit'
  | 'device-bridge'
  | 'workspace'
  | 'schema'
  | 'quota';

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
    deviceArtifacts: new Map(persisted.deviceArtifacts.map((record) => [record.id, record])),
    deviceBridgeRequests: new Map(persisted.deviceBridgeRequests.map((record) => [record.id, record])),
    deviceBridgeApprovals: new Map(persisted.deviceBridgeApprovals.map((record) => [record.id, record])),
    deviceBridgeOperations: new Map(persisted.deviceBridgeOperations.map((record) => [record.id, record])),
    deviceInventoryBindings: new Map(persisted.deviceInventoryBindings.map((record) => [record.id, record])),
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
    deviceBridgePolicy: getDeviceBridgePolicy(),
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

  if (!managedThread && activeSessionCountForUser(state, user.id) >= state.maxActiveSessionsPerUser) {
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
        addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
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
        addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
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
      addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
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

export function requestDeviceBridgeIntake(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  payload: unknown,
): DeviceBridgeRequestResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  if (!deviceBridgeRequestIntakeEnabled()) {
    if (!auditHmacKey) return publicDeviceBridgeDenial('device-bridge');
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'device-bridge',
      auditHmacKey,
    );
  }
  if (!auditHmacKey) {
    return publicDeviceBridgeDenial('audit');
  }

  if (user.authMode !== 'protected-gateway') {
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'auth',
      auditHmacKey,
    );
  }

  const parsed = parseDeviceBridgeRequestPayload(payload);
  if (!parsed.ok) {
    return denyDeviceBridgeRequest(state, user, sessionId, 'schema', auditHmacKey);
  }

  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (
    !session ||
    !isManagedSessionAuthorized(state, user, session) ||
    session.lifecycle !== 'ready'
  ) {
    return denyDeviceBridgeRequest(state, user, sessionId, 'session', auditHmacKey);
  }

  const workspaceDecision = resolveWorkspaceForUser(user, parsed.payload.workspaceId);
  if (
    !workspaceDecision.ok ||
    workspaceDecision.workspace.id !== session.workspace.id ||
    workspaceDecision.workspace.root !== session.workspace.root
  ) {
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'workspace',
      auditHmacKey,
    );
  }

  const artifact = state.deviceArtifacts.get(parsed.payload.artifactId);
  if (
    !artifact ||
    artifact.projectId !== session.workspace.id ||
    artifact.sessionId !== session.id ||
    artifact.sha256.toLowerCase() !== parsed.payload.artifactSha256.toLowerCase()
  ) {
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'artifact',
      auditHmacKey,
    );
  }

  const inventoryBinding = state.deviceInventoryBindings.get(parsed.payload.inventoryBindingId);
  if (!validActiveInventoryBindingForRequest(inventoryBinding, session.workspace.id)) {
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'inventory',
      auditHmacKey,
    );
  }

  if (pendingDeviceBridgeRequestCountForSession(state, session.id) >= 3) {
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'quota',
      auditHmacKey,
    );
  }
  if (pendingDeviceBridgeRequestCountForUser(state, user.id) >= 5) {
    return denyDeviceBridgeRequest(
      state,
      user,
      sessionId,
      'quota',
      auditHmacKey,
    );
  }

  const createdAt = new Date().toISOString();
  const request: DeviceBridgeRequestRecord = {
    id: `bridge-request-${randomUUID()}`,
    userId: user.id,
    sessionId: session.id,
    projectId: session.workspace.id,
    artifactId: artifact.id,
    artifactSha256: artifact.sha256.toLowerCase(),
    inventoryBindingId: inventoryBinding.id,
    deviceIdentityTag: inventoryBinding.deviceIdentityTag.toLowerCase(),
    operation: 'esp32.flash',
    status: 'pending',
    createdAt,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.request',
    session.id,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'created',
      userId: user.id,
      sessionId: session.id,
      requestId: request.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceBridgeRequests: [...state.deviceBridgeRequests.values(), request],
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceBridgeRequests.set(request.id, request);
  state.audit.events.push(auditEvent);
  return { ok: true, request: publicDeviceBridgeRequest(request) };
}

export function registerDeviceArtifactMetadata(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  payload: unknown,
): DeviceBridgeMetadataResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  if (!deviceBridgeMetadataRegistryEnabled()) {
    return auditHmacKey
      ? denyDeviceBridgeMetadata(state, user, sessionId, 'device-bridge', auditHmacKey)
      : publicDeviceBridgeMetadataDenial('device-bridge');
  }
  if (!auditHmacKey) return publicDeviceBridgeMetadataDenial('audit');
  if (user.authMode !== 'protected-gateway') {
    return denyDeviceBridgeMetadata(state, user, sessionId, 'auth', auditHmacKey);
  }

  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready') {
    return denyDeviceBridgeMetadata(state, user, sessionId, 'session', auditHmacKey);
  }

  const parsed = parseDeviceArtifactMetadataPayload(payload);
  if (!parsed.ok) {
    return denyDeviceBridgeMetadata(state, user, session.id, 'schema', auditHmacKey);
  }
  const artifactFile = readProjectArtifactMetadata(session.workspace.root, parsed.payload);
  if (!artifactFile.ok) {
    return denyDeviceBridgeMetadata(state, user, session.id, 'schema', auditHmacKey);
  }
  if (activeDeviceArtifactCountForSession(state, session.id) >= 20) {
    return denyDeviceBridgeMetadata(state, user, session.id, 'quota', auditHmacKey);
  }
  if (activeDeviceArtifactCountForProject(state, session.workspace.id) >= 50) {
    return denyDeviceBridgeMetadata(state, user, session.id, 'quota', auditHmacKey);
  }

  const createdAt = new Date().toISOString();
  const artifact: DeviceArtifactMetadata = {
    id: `artifact-${randomUUID()}`,
    projectId: session.workspace.id,
    sessionId: session.id,
    producerUserId: user.id,
    producerThreadId: session.codexThreadId,
    label: artifactFile.metadata.label,
    byteLength: artifactFile.metadata.byteLength,
    mediaType: 'application/octet-stream',
    format: 'esp32-firmware-bin',
    sha256: artifactFile.metadata.sha256,
    storageReference: `artifact-ref-${randomUUID()}`,
    status: 'active',
    createdAt,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.artifact',
    session.id,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'artifact_registered',
      userId: user.id,
      sessionId: session.id,
      requestId: artifact.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceArtifacts: [...state.deviceArtifacts.values(), artifact],
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceArtifacts.set(artifact.id, artifact);
  state.audit.events.push(auditEvent);
  return { ok: true, artifact: publicDeviceArtifactMetadata(artifact) };
}

export function listDeviceArtifactMetadata(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): DeviceArtifactMetadataPublic[] | undefined {
  if (!deviceBridgeMetadataRegistryEnabled() || user.authMode !== 'protected-gateway') return undefined;
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session)) return undefined;
  return [...state.deviceArtifacts.values()]
    .filter((artifact) =>
      artifact.sessionId === session.id &&
      artifact.projectId === session.workspace.id &&
      artifact.status === 'active' &&
      Date.parse(artifact.expiresAt) > Date.now(),
    )
    .map(publicDeviceArtifactMetadata);
}

export function revokeDeviceArtifactMetadata(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  artifactId: string,
): DeviceBridgeMetadataResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  if (!deviceBridgeMetadataRegistryEnabled()) {
    return auditHmacKey
      ? denyDeviceBridgeMetadata(state, user, sessionId, 'device-bridge', auditHmacKey)
      : publicDeviceBridgeMetadataDenial('device-bridge');
  }
  if (!auditHmacKey) return publicDeviceBridgeMetadataDenial('audit');
  if (user.authMode !== 'protected-gateway') {
    return denyDeviceBridgeMetadata(state, user, sessionId, 'auth', auditHmacKey);
  }
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  const artifact = state.deviceArtifacts.get(artifactId);
  if (
    !session ||
    !isManagedSessionAuthorized(state, user, session) ||
    !artifact ||
    artifact.sessionId !== session.id ||
    artifact.projectId !== session.workspace.id
  ) {
    return denyDeviceBridgeMetadata(state, user, sessionId, 'session', auditHmacKey);
  }
  const revoked: DeviceArtifactMetadata = {
    ...artifact,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.artifact',
    session.id,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'artifact_revoked',
      userId: user.id,
      sessionId: session.id,
      requestId: artifact.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceArtifacts: [...state.deviceArtifacts.values()].map((record) => record.id === artifact.id ? revoked : record),
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceArtifacts.set(artifact.id, revoked);
  state.audit.events.push(auditEvent);
  return { ok: true, artifact: publicDeviceArtifactMetadata(revoked) };
}

export function createDeviceInventoryBinding(
  state: RoadexState,
  user: UserProfile,
  payload: unknown,
): DeviceInventoryBindingResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const identityHmacKey = deviceBridgeIdentityHmacKey();
  if (!deviceBridgeMetadataRegistryEnabled()) {
    return auditHmacKey
      ? denyDeviceInventoryBinding(state, user, 'device-bridge', 'device-bridge', auditHmacKey)
      : publicDeviceInventoryBindingDenial('device-bridge');
  }
  if (!auditHmacKey) return publicDeviceInventoryBindingDenial('audit');
  if (!identityHmacKey) {
    return denyDeviceInventoryBinding(state, user, 'device-bridge', 'audit', auditHmacKey);
  }
  if (user.authMode !== 'protected-gateway' || !canAuthorizeInventoryBinding(user)) {
    return denyDeviceInventoryBinding(state, user, 'device-bridge', 'auth', auditHmacKey);
  }
  const parsed = parseDeviceInventoryBindingPayload(payload);
  if (!parsed.ok) {
    return denyDeviceInventoryBinding(state, user, 'device-bridge', 'schema', auditHmacKey);
  }
  const workspaceDecision = resolveWorkspaceForUser(user, parsed.payload.projectId);
  if (!workspaceDecision.ok) {
    return denyDeviceInventoryBinding(state, user, parsed.payload.projectId, 'workspace', auditHmacKey);
  }
  if (activeInventoryBindingCountForProject(state, workspaceDecision.workspace.id) >= 25) {
    return denyDeviceInventoryBinding(state, user, workspaceDecision.workspace.id, 'quota', auditHmacKey);
  }
  const deviceIdentityTag = applicationHmacTag(
    identityHmacKey,
    normalizedDeviceIdentity(parsed.payload.normalizedDeviceIdentity, workspaceDecision.workspace.id),
  );
  const duplicate = [...state.deviceInventoryBindings.values()].some(
    (binding) =>
      binding.projectId === workspaceDecision.workspace.id &&
      binding.deviceIdentityTag === deviceIdentityTag &&
      binding.allowedOperation === parsed.payload.allowedOperation &&
      binding.lifecycle === 'active',
  );
  if (duplicate) {
    return denyDeviceInventoryBinding(state, user, workspaceDecision.workspace.id, 'quota', auditHmacKey);
  }

  const binding: DeviceInventoryBindingRecord = {
    id: `inventory-binding-${randomUUID()}`,
    projectId: workspaceDecision.workspace.id,
    deviceIdentityTag,
    allowedOperation: 'esp32.flash',
    secureBootExpected: parsed.payload.secureBootExpected,
    flashEncryptionExpected: parsed.payload.flashEncryptionExpected,
    lifecycle: 'active',
    createdBy: user.id,
    createdAt: new Date().toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.inventory_binding',
    workspaceDecision.workspace.id,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'inventory_binding_created',
      userId: user.id,
      sessionId: workspaceDecision.workspace.id,
      requestId: binding.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceInventoryBindings: [...state.deviceInventoryBindings.values(), binding],
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceInventoryBindings.set(binding.id, binding);
  state.audit.events.push(auditEvent);
  return { ok: true, binding };
}

export function listDeviceInventoryBindings(
  state: RoadexState,
  user: UserProfile,
  projectId: string,
): DeviceInventoryBindingRecord[] | undefined {
  if (
    !deviceBridgeMetadataRegistryEnabled() ||
    !deviceBridgeIdentityHmacKey() ||
    user.authMode !== 'protected-gateway' ||
    !canAuthorizeInventoryBinding(user)
  ) {
    return undefined;
  }
  const workspaceDecision = resolveWorkspaceForUser(user, projectId);
  if (!workspaceDecision.ok) return undefined;
  return [...state.deviceInventoryBindings.values()].filter(
    (binding) => binding.projectId === workspaceDecision.workspace.id && binding.lifecycle === 'active',
  );
}

export function revokeDeviceInventoryBinding(
  state: RoadexState,
  user: UserProfile,
  bindingId: string,
): DeviceInventoryBindingResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const identityHmacKey = deviceBridgeIdentityHmacKey();
  if (!deviceBridgeMetadataRegistryEnabled()) {
    return auditHmacKey
      ? denyDeviceInventoryBinding(state, user, 'device-bridge', 'device-bridge', auditHmacKey)
      : publicDeviceInventoryBindingDenial('device-bridge');
  }
  if (!auditHmacKey) return publicDeviceInventoryBindingDenial('audit');
  if (!identityHmacKey) {
    return denyDeviceInventoryBinding(state, user, 'device-bridge', 'audit', auditHmacKey);
  }
  if (user.authMode !== 'protected-gateway' || !canAuthorizeInventoryBinding(user)) {
    return denyDeviceInventoryBinding(state, user, 'device-bridge', 'auth', auditHmacKey);
  }
  const binding = state.deviceInventoryBindings.get(bindingId);
  if (!binding || !resolveWorkspaceForUser(user, binding.projectId).ok) {
    return denyDeviceInventoryBinding(state, user, 'device-bridge', 'workspace', auditHmacKey);
  }
  const revoked: DeviceInventoryBindingRecord = {
    ...binding,
    lifecycle: 'revoked',
    revokedAt: new Date().toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.inventory_binding',
    binding.projectId,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'inventory_binding_revoked',
      userId: user.id,
      sessionId: binding.projectId,
      requestId: binding.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceInventoryBindings: [...state.deviceInventoryBindings.values()].map((record) => record.id === binding.id ? revoked : record),
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceInventoryBindings.set(binding.id, revoked);
  state.audit.events.push(auditEvent);
  return { ok: true, binding: revoked };
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
    return deny('device-bridge', 'Client device bridge implementation is disabled pending separate exposure and hardware approvals.');
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

function denyDeviceBridgeRequest(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  gate: DeviceBridgeRequestGate,
  auditHmacKey: string,
): DeviceBridgeRequestResponse {
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'security.denied',
    sessionId,
    'denied',
    bridgeAuditSummary(auditHmacKey, {
      classification: gate,
      userId: user.id,
      sessionId,
    }),
  );
  persistStateSnapshot(state, {
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.audit.events.push(auditEvent);
  return publicDeviceBridgeDenial(gate);
}

function publicDeviceBridgeDenial(classification: DeviceBridgeRequestGate): DeviceBridgeRequestResponse {
  return {
    ok: false,
    gate: 'device-bridge',
    reason: 'Device bridge request denied.',
    classification,
  };
}

function denyDeviceBridgeMetadata(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  gate: DeviceBridgeMetadataGate,
  auditHmacKey: string,
): DeviceBridgeMetadataResponse {
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'security.denied',
    sessionId,
    'denied',
    bridgeAuditSummary(auditHmacKey, {
      classification: gate,
      userId: user.id,
      sessionId,
    }),
  );
  persistStateSnapshot(state, {
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.audit.events.push(auditEvent);
  return publicDeviceBridgeMetadataDenial(gate);
}

function publicDeviceBridgeMetadataDenial(classification: DeviceBridgeMetadataGate): DeviceBridgeMetadataResponse {
  return {
    ok: false,
    gate: 'device-bridge',
    reason: 'Device bridge metadata denied.',
    classification,
  };
}

function publicDeviceArtifactMetadata(artifact: DeviceArtifactMetadata): DeviceArtifactMetadataPublic {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    producerUserId: artifact.producerUserId,
    producerThreadId: artifact.producerThreadId,
    producerRunId: artifact.producerRunId,
    label: artifact.label,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    format: artifact.format,
    sha256: artifact.sha256,
    status: artifact.status,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    revokedAt: artifact.revokedAt,
  };
}

function publicDeviceBridgeRequest(request: DeviceBridgeRequestRecord): DeviceBridgeRequestPublic {
  return {
    id: request.id,
    userId: request.userId,
    sessionId: request.sessionId,
    projectId: request.projectId,
    artifactId: request.artifactId,
    artifactSha256: request.artifactSha256,
    inventoryBindingId: request.inventoryBindingId,
    operation: request.operation,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function denyDeviceInventoryBinding(
  state: RoadexState,
  user: UserProfile,
  resource: string,
  gate: DeviceInventoryBindingGate,
  auditHmacKey: string,
): DeviceInventoryBindingResponse {
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'security.denied',
    resource,
    'denied',
    bridgeAuditSummary(auditHmacKey, {
      classification: gate,
      userId: user.id,
      sessionId: resource,
    }),
  );
  persistStateSnapshot(state, {
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.audit.events.push(auditEvent);
  return publicDeviceInventoryBindingDenial(gate);
}

function publicDeviceInventoryBindingDenial(classification: DeviceInventoryBindingGate): DeviceInventoryBindingResponse {
  return {
    ok: false,
    gate: 'device-bridge',
    reason: 'Device bridge inventory binding denied.',
    classification,
  };
}

function createBridgeAuditEvent(
  state: RoadexState,
  auditHmacKey: string,
  user: UserProfile,
  action: AuditEvent['action'],
  resource: string,
  outcome: AuditEvent['outcome'],
  summary: string,
): AuditEvent {
  return {
    id: `audit-${state.audit.events.length + 1}`,
    at: new Date().toISOString(),
    actorId: auditTag(auditHmacKey, user.id),
    action,
    resource: auditTag(auditHmacKey, resource),
    outcome,
    summary,
  };
}

function bridgeAuditSummary(
  key: string,
  fields: {
    classification: string;
    userId: string;
    sessionId: string;
    requestId?: string;
  },
): string {
  return [
    'Device bridge intake event.',
    `classification=${fields.classification}`,
    `actor_tag=${auditTag(key, fields.userId)}`,
    `session_tag=${auditTag(key, fields.sessionId)}`,
    ...(fields.requestId ? [`request_tag=${auditTag(key, fields.requestId)}`] : []),
  ].join(' ');
}

function auditTag(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex').slice(0, 16);
}

function applicationHmacTag(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function pendingDeviceBridgeRequestCountForSession(state: RoadexState, sessionId: string): number {
  const now = Date.now();
  return [...state.deviceBridgeRequests.values()].filter(
    (request) => request.sessionId === sessionId && request.status === 'pending' && Date.parse(request.expiresAt) > now,
  ).length;
}

function pendingDeviceBridgeRequestCountForUser(state: RoadexState, userId: string): number {
  const now = Date.now();
  return [...state.deviceBridgeRequests.values()].filter(
    (request) => request.userId === userId && request.status === 'pending' && Date.parse(request.expiresAt) > now,
  ).length;
}

function activeDeviceArtifactCountForSession(state: RoadexState, sessionId: string): number {
  const now = Date.now();
  return [...state.deviceArtifacts.values()].filter(
    (artifact) => artifact.sessionId === sessionId && artifact.status === 'active' && Date.parse(artifact.expiresAt) > now,
  ).length;
}

function activeDeviceArtifactCountForProject(state: RoadexState, projectId: string): number {
  const now = Date.now();
  return [...state.deviceArtifacts.values()].filter(
    (artifact) => artifact.projectId === projectId && artifact.status === 'active' && Date.parse(artifact.expiresAt) > now,
  ).length;
}

function activeInventoryBindingCountForProject(state: RoadexState, projectId: string): number {
  return [...state.deviceInventoryBindings.values()].filter(
    (binding) => binding.projectId === projectId && binding.lifecycle === 'active',
  ).length;
}

function parseDeviceArtifactMetadataPayload(payload: unknown): {
  ok: true;
  payload: DeviceArtifactMetadataRegistrationPayload;
} | {
  ok: false;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = record.label === undefined ? ['artifactPath'] : ['artifactPath', 'label'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return { ok: false };
  if (
    typeof record.artifactPath !== 'string' ||
    !validProjectRelativeArtifactPath(record.artifactPath) ||
    (record.label !== undefined && (
      typeof record.label !== 'string' ||
      !validArtifactLabel(record.label)
    ))
  ) return { ok: false };
  return {
    ok: true,
    payload: {
      artifactPath: record.artifactPath.trim(),
      label: record.label === undefined ? basename(record.artifactPath.trim()) : record.label.trim(),
    },
  };
}

function readProjectArtifactMetadata(
  workspaceRoot: string,
  payload: DeviceArtifactMetadataRegistrationPayload,
): {
  ok: true;
  metadata: Pick<DeviceArtifactMetadata, 'label' | 'byteLength' | 'sha256'>;
} | {
  ok: false;
} {
  let fd: number | undefined;
  try {
    const label = payload.label;
    if (typeof label !== 'string' || !validArtifactLabel(label) || extname(label).toLowerCase() !== '.bin') {
      return { ok: false };
    }
    const root = realpathSync(workspaceRoot);
    const artifactPath = resolve(root, payload.artifactPath);
    if (!isPathWithin(root, artifactPath)) return { ok: false };
    if (hasSymlinkPathComponent(root, payload.artifactPath)) return { ok: false };
    fd = openSync(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > 16 * 1024 * 1024) return { ok: false };
    const descriptorPath = realpathSync(`/proc/self/fd/${fd}`);
    if (!isPathWithin(root, descriptorPath)) return { ok: false };
    if (extname(descriptorPath).toLowerCase() !== '.bin') return { ok: false };
    const hashed = hashOpenFileDescriptor(fd, before.size);
    if (!hashed.ok) return { ok: false };
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) return { ok: false };
    return {
      ok: true,
      metadata: {
        label,
        byteLength: hashed.byteLength,
        sha256: hashed.sha256,
      },
    };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function hashOpenFileDescriptor(fd: number, expectedSize: number): {
  ok: true;
  byteLength: number;
  sha256: string;
} | {
  ok: false;
} {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expectedSize) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.byteLength, expectedSize - offset), offset);
    if (bytesRead <= 0) return { ok: false };
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
    if (offset > 16 * 1024 * 1024) return { ok: false };
  }
  if (offset <= 0 || offset !== expectedSize || offset > 16 * 1024 * 1024) return { ok: false };
  return {
    ok: true,
    byteLength: offset,
    sha256: hash.digest('hex'),
  };
}

function validProjectRelativeArtifactPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.includes('\0') || trimmed.includes('\\')) return false;
  if (isAbsolute(trimmed) || trimmed.endsWith('/')) return false;
  const segments = trimmed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => segment.length > 128)) return false;
  return extname(trimmed).toLowerCase() === '.bin';
}

function validArtifactLabel(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(value) && extname(value).toLowerCase() === '.bin';
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function hasSymlinkPathComponent(root: string, projectRelativePath: string): boolean {
  let current = root;
  for (const segment of projectRelativePath.split('/')) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function parseDeviceInventoryBindingPayload(payload: unknown): {
  ok: true;
  payload: DeviceInventoryBindingPayload;
} | {
  ok: false;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    'allowedOperation',
    'flashEncryptionExpected',
    'normalizedDeviceIdentity',
    'projectId',
    'secureBootExpected',
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return { ok: false };
  if (
    !boundedToken(record.projectId, 128) ||
    typeof record.normalizedDeviceIdentity !== 'string' ||
    record.normalizedDeviceIdentity.trim().length < 8 ||
    record.normalizedDeviceIdentity.trim().length > 256 ||
    /[\r\n/\\]/.test(record.normalizedDeviceIdentity) ||
    record.allowedOperation !== 'esp32.flash' ||
    !expectedDeviceSecurityValue(record.secureBootExpected) ||
    !expectedDeviceSecurityValue(record.flashEncryptionExpected)
  ) return { ok: false };
  return {
    ok: true,
    payload: {
      projectId: record.projectId.trim(),
      normalizedDeviceIdentity: record.normalizedDeviceIdentity.trim().toLowerCase(),
      allowedOperation: 'esp32.flash',
      secureBootExpected: record.secureBootExpected,
      flashEncryptionExpected: record.flashEncryptionExpected,
    },
  };
}

function expectedDeviceSecurityValue(value: unknown): value is DeviceInventoryBindingPayload['secureBootExpected'] {
  return value === 'required' || value === 'not-required' || value === 'unknown';
}

function canAuthorizeInventoryBinding(user: UserProfile): boolean {
  return user.roles.includes('admin') || user.roles.includes('security-reviewer');
}

function normalizedDeviceIdentity(value: string, projectId: string): string {
  return `roadex-device-bridge-identity:v1:${projectId}:${value.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function parseDeviceBridgeRequestPayload(payload: unknown): {
  ok: true;
  payload: DeviceBridgeRequestPayload;
} | {
  ok: false;
  reason: string;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'Device bridge request body must be an object.' };
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['artifactId', 'artifactSha256', 'inventoryBindingId', 'operation', 'workspaceId'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, reason: 'Device bridge request schema is invalid.' };
  }
  if (
    !boundedToken(record.workspaceId, 128) ||
    !boundedToken(record.artifactId, 128) ||
    !boundedToken(record.inventoryBindingId, 128) ||
    record.operation !== 'esp32.flash' ||
    typeof record.artifactSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(record.artifactSha256)
  ) {
    return { ok: false, reason: 'Device bridge request schema is invalid.' };
  }
  return {
    ok: true,
    payload: {
      workspaceId: record.workspaceId.trim(),
      artifactId: record.artifactId.trim(),
      artifactSha256: record.artifactSha256.toLowerCase(),
      inventoryBindingId: record.inventoryBindingId.trim(),
      operation: 'esp32.flash',
    },
  };
}

function boundedToken(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validActiveInventoryBindingForRequest(
  binding: DeviceInventoryBindingRecord | undefined,
  projectId: string,
): binding is DeviceInventoryBindingRecord {
  return Boolean(
    binding &&
    binding.projectId === projectId &&
    binding.allowedOperation === 'esp32.flash' &&
    binding.lifecycle === 'active' &&
    !binding.revokedAt &&
    /^[a-f0-9]{64}$/i.test(binding.deviceIdentityTag),
  );
}

function saveState(state: RoadexState): void {
  state.persistence.save(serializeState({
    sessions: state.sessions.sessions,
    streamEvents: state.sessions.streamEvents,
    auditEvents: state.audit.events,
    managedThreadClaims: [...state.managedThreadClaims.values()],
    deviceArtifacts: [...state.deviceArtifacts.values()],
    deviceBridgeRequests: [...state.deviceBridgeRequests.values()],
    deviceBridgeApprovals: [...state.deviceBridgeApprovals.values()],
    deviceBridgeOperations: [...state.deviceBridgeOperations.values()],
    deviceInventoryBindings: [...state.deviceInventoryBindings.values()],
  }));
}

function persistStateSnapshot(
  state: RoadexState,
  overrides: Partial<{
    sessions: RoadexSession[];
    streamEvents: StreamEvent[];
    auditEvents: AuditEvent[];
    managedThreadClaims: ManagedThreadClaim[];
    deviceArtifacts: DeviceArtifactMetadata[];
    deviceBridgeRequests: DeviceBridgeRequestRecord[];
    deviceBridgeApprovals: DeviceBridgeApprovalRecord[];
    deviceBridgeOperations: DeviceBridgeOperationRecord[];
    deviceInventoryBindings: DeviceInventoryBindingRecord[];
  }>,
): void {
  state.persistence.save(serializeState({
    sessions: overrides.sessions ?? state.sessions.sessions,
    streamEvents: overrides.streamEvents ?? state.sessions.streamEvents,
    auditEvents: overrides.auditEvents ?? state.audit.events,
    managedThreadClaims: overrides.managedThreadClaims ?? [...state.managedThreadClaims.values()],
    deviceArtifacts: overrides.deviceArtifacts ?? [...state.deviceArtifacts.values()],
    deviceBridgeRequests: overrides.deviceBridgeRequests ?? [...state.deviceBridgeRequests.values()],
    deviceBridgeApprovals: overrides.deviceBridgeApprovals ?? [...state.deviceBridgeApprovals.values()],
    deviceBridgeOperations: overrides.deviceBridgeOperations ?? [...state.deviceBridgeOperations.values()],
    deviceInventoryBindings: overrides.deviceInventoryBindings ?? [...state.deviceInventoryBindings.values()],
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
  const bridgeAuditKey = deviceBridgeAuditHmacKey();
  const bridgeActorTag = bridgeAuditKey ? auditTag(bridgeAuditKey, user.id) : undefined;
  return audit.events.filter(
    (event) => event.actorId === user.id || (bridgeActorTag !== undefined && event.actorId === bridgeActorTag),
  );
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
