import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { appendAudit, createAuditLogFromEvents, type AuditLog } from './auditLog.js';
import { createCodexRunner, type RunnerPromptResult, type SessionRunner } from './codexRunner.js';
import {
  denyDeviceBridge,
  deviceBridgeAuditHmacKey,
  deviceBridgeApprovalEnabled,
  deviceBridgeIdentityHmacKey,
  deviceBridgeDescriptorHmacKey,
  deviceBridgeDescriptorObservationEnabled,
  deviceBridgeMetadataRegistryEnabled,
  deviceBridgeProbeEnabled,
  deviceBridgeWriteEnabled,
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
import { loadProjectDeviceManifest } from './projectDeviceManifest.js';
import { maxDeviceArtifactBytes, readDeviceArtifact, storeDeviceArtifact } from './deviceArtifactVault.js';
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
  type RecoverSessionResponse,
  type PromptAcceptedResponse,
} from '../shared/sessionContracts.js';
import type {
  DeviceArtifactMetadata,
  DeviceArtifactMetadataPublic,
  DeviceArtifactMetadataRegistrationPayload,
  DeviceBridgeApprovalPublic,
  DeviceBridgeApprovalRecord,
  DeviceBridgeApprovalResponse,
  DeviceBridgeMetadataResponse,
  DeviceBridgeOperationRecord,
  DeviceBridgeOperationPublic,
  DeviceBridgeProbePayload,
  DeviceBridgeProbeResponse,
  DeviceBridgeProbeStartResponse,
  DeviceBridgeRequestPayload,
  DeviceBridgeRequestPublic,
  DeviceBridgeRequestRecord,
  DeviceBridgeRequestResponse,
  DeviceBridgeWriteAuthorizationResponse,
  DeviceDescriptorObservationPayload,
  DeviceDescriptorObservationPublic,
  DeviceDescriptorObservationRecord,
  DeviceDescriptorObservationResponse,
  DeviceInventoryBindingPayload,
  DeviceInventoryBindingPublic,
  DeviceInventoryBindingRecord,
  DeviceInventoryBindingResponse,
} from '../shared/deviceBridgeContracts.js';
import type { SerialVerificationProfile } from '../shared/serialVerificationContracts.js';
import type { BleVerificationProfile } from '../shared/bleVerificationContracts.js';
import type { UsbDeviceOperation, UsbDeviceProfile } from '../shared/usbDeviceProfileContracts.js';
import type {
  ControlledRunnerGrant,
  RunnerCapabilityContext,
} from './runnerCapabilityProfile.js';
import type { ControlledOperationGrantIssueContext } from './controlledOperationGrantIssuer.js';
import type {
  ApprovalContinuationCompletionOutcome,
  ApprovalContinuationCompletionResult,
  ApprovalContinuationDispatchResult,
  ApprovalSessionCapability,
} from './approvalCoordinator.js';
import { buildApprovalContinuation } from './approvalContinuation.js';
import {
  isActiveApprovalWait,
  type ApprovalWaitRecord,
} from '../shared/approvalWorkflowContracts.js';

export type ApprovalWorkflowGrantScope = ApprovalSessionCapability & { runId: string };

export type ApprovalLifecycleBridge = {
  hasActiveWait: (sessionId: string) => boolean;
  issueWorkflowGrant: (scope: ApprovalWorkflowGrantScope) => string | undefined;
  revokeWorkflowGrant: (runId: string) => void;
  completeContinuation: (
    continuationId: string,
    runnerRunId: string,
    outcome: ApprovalContinuationCompletionOutcome,
  ) => Promise<ApprovalContinuationCompletionResult | undefined>;
};

export type HumanApprovalPendingResponse = {
  accepted: false;
  code: 'human-approval-pending';
};

type ActiveApprovalRun = {
  capability: ApprovalSessionCapability;
  waitId?: string;
  continuationId?: string;
};

type UserApprovalWorkflowRun = {
  runnerRunId: string;
  approvalWorkflowToken: string;
};

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
  approvalWaits: ApprovalWaitRecord[];
  approvalLifecycle: ApprovalLifecycleBridge;
  activeApprovalRuns: Map<string, ActiveApprovalRun>;
  generateApprovalRunId: () => string;
  deviceArtifacts: Map<string, DeviceArtifactMetadata>;
  deviceBridgeRequests: Map<string, DeviceBridgeRequestRecord>;
  deviceBridgeApprovals: Map<string, DeviceBridgeApprovalRecord>;
  deviceBridgeOperations: Map<string, DeviceBridgeOperationRecord>;
  deviceInventoryBindings: Map<string, DeviceInventoryBindingRecord>;
  deviceDescriptorObservations: Map<string, DeviceDescriptorObservationRecord>;
  serialVerificationProfiles: SerialVerificationProfile[];
  bleVerificationProfiles: BleVerificationProfile[];
  usbDeviceProfiles: UsbDeviceProfile[];
  resolveControlledRunnerGrant: (context: RunnerCapabilityContext) => ControlledRunnerGrant | undefined;
  issueControlledOperationToken: (context: ControlledOperationGrantIssueContext) => string | undefined;
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

type DeviceBridgeApprovalGate =
  | 'auth'
  | 'audit'
  | 'device-bridge'
  | 'request'
  | 'session'
  | 'artifact'
  | 'inventory';

type DeviceDescriptorObservationGate =
  | 'auth'
  | 'audit'
  | 'device-bridge'
  | 'session'
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
  const deviceProfiles = loadProjectDeviceManifest();
  const managedThreadClaims = new Map(persisted.managedThreadClaims.map((claim) => [claim.threadId, claim]));
  const approvalWaits = persisted.approvalWaits;
  const approvalLifecycle: ApprovalLifecycleBridge = {
    hasActiveWait: (sessionId) => approvalWaits.some(
      (wait) => wait.sessionId === sessionId && isActiveApprovalWait(wait.state),
    ),
    issueWorkflowGrant: () => undefined,
    revokeWorkflowGrant: () => undefined,
    completeContinuation: async () => undefined,
  };
  for (const session of persisted.sessions) {
    if (session.managedThreadId && !managedThreadClaims.has(session.managedThreadId)) {
      managedThreadClaims.set(session.managedThreadId, {
        threadId: session.managedThreadId,
        userId: session.userId,
        claimedAt: session.createdAt,
      });
    }
  }
  const state: RoadexState = {
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
    approvalWaits,
    approvalLifecycle,
    activeApprovalRuns: new Map(),
    generateApprovalRunId: () => `run-${randomBytes(16).toString('hex')}`,
    deviceArtifacts: new Map(persisted.deviceArtifacts.map((record) => [record.id, record])),
    deviceBridgeRequests: new Map(persisted.deviceBridgeRequests.map((record) => [record.id, record])),
    deviceBridgeApprovals: new Map(persisted.deviceBridgeApprovals.map((record) => [record.id, record])),
    deviceBridgeOperations: new Map(persisted.deviceBridgeOperations.map((record) => [record.id, record])),
    deviceInventoryBindings: new Map(persisted.deviceInventoryBindings.map((record) => [record.id, record])),
    deviceDescriptorObservations: new Map(persisted.deviceDescriptorObservations.map((record) => [record.id, record])),
    resolveControlledRunnerGrant: () => undefined,
    issueControlledOperationToken: () => undefined,
    ...deviceProfiles,
  };
  return state;
}

export async function bootstrap(state: RoadexState, user: UserProfile): Promise<RoadexBootstrap> {
  const approvedWorkspaces = getApprovedWorkspaces(user);
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
    workspaces: approvedWorkspaces,
    sessions: userSessions,
    auditEvents: visibleAuditEvents(state.audit, user).slice(-8).reverse(),
    streamPreview: state.sessions.streamEvents.filter((event) => visibleSessionIds.has(event.sessionId)).slice(-8),
    managedThreads: canAccessManagedCodexProjects(user) ? safeManagedThreads(user) : [],
    deviceBridgePolicy: getDeviceBridgePolicy(),
    deviceInventoryBindingRefs: user.authMode === 'protected-gateway' && canAuthorizeInventoryBinding(user)
      ? [...state.deviceInventoryBindings.values()]
        .filter((binding) => binding.lifecycle === 'active' && getApprovedWorkspaces(user).some((workspace) => workspace.id === binding.projectId))
        .map((binding) => ({
          id: binding.id,
          projectId: binding.projectId,
          identityVerificationAvailable: Boolean(binding.deviceMacTag),
        }))
      : [],
    serialVerificationProfiles: state.serialVerificationProfiles.filter((profile) =>
      approvedWorkspaces.some((workspace) => workspace.id === profile.workspaceId)),
    bleVerificationProfiles: state.bleVerificationProfiles.filter((profile) =>
      approvedWorkspaces.some((workspace) => workspace.id === profile.workspaceId)),
    usbDeviceProfiles: state.usbDeviceProfiles.filter((profile) =>
      approvedWorkspaces.some((workspace) => workspace.id === profile.workspaceId)),
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
): PromptAcceptedResponse | HumanApprovalPendingResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session)) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Session is unavailable to this user.');
    saveState(state);
    return undefined;
  }
  if (hasActiveApprovalWait(state, session.id)) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Human approval is pending.');
    saveState(state);
    return { accepted: false, code: 'human-approval-pending' };
  }
  if (session.lifecycle === 'closed' || session.lifecycle === 'blocked' || session.lifecycle === 'streaming') {
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

  return startSessionRun(state, session, cleanPrompt, { kind: 'user', user });
}

export async function dispatchApprovalContinuation(
  state: RoadexState,
  wait: ApprovalWaitRecord,
  prompt: string,
): Promise<ApprovalContinuationDispatchResult> {
  const session = state.sessions.sessions.find((candidate) => candidate.id === wait.sessionId);
  if (!session || session.lifecycle === 'closed') {
    return denyApprovalDispatch(state, wait.sessionId, 'session-closed');
  }
  if (
    !session.managedThreadId
    || session.managedThreadId !== wait.managedThreadId
    || session.codexThreadId !== wait.managedThreadId
  ) {
    return denyApprovalDispatch(state, wait.sessionId, 'thread-mismatch');
  }

  const liveWait = state.approvalWaits.find((candidate) => candidate === wait);
  let canonicalPrompt: string;
  try {
    canonicalPrompt = buildApprovalContinuation(wait);
  } catch {
    return denyApprovalDispatch(state, wait.sessionId, 'scope-mismatch');
  }
  if (
    !liveWait
    || wait.state !== 'resume-dispatching'
    || wait.runnerRunId !== undefined
    || session.lifecycle !== 'paused'
    || session.userId !== wait.userId
    || session.workspace.id !== wait.workspaceId
    || session.workspace.id !== wait.projectId
    || session.waitingApproval?.waitId !== wait.id
    || session.waitingApproval.state !== wait.state
    || session.waitingApproval.approvalRef !== wait.approvalRef
    || session.waitingApproval.subject !== wait.subject
    || session.waitingApproval.consoleSurface !== wait.consoleSurface
    || session.waitingApproval.updatedAt !== wait.updatedAt
    || prompt !== canonicalPrompt
    || state.activeRuns.has(session.id)
    || [...state.activeApprovalRuns.values()].some((active) => active.continuationId === wait.continuationId)
  ) {
    return denyApprovalDispatch(state, wait.sessionId, 'scope-mismatch');
  }

  if (state.activeRuns.size >= state.maxActiveRuns) {
    return { status: 'capacity', retryAt: new Date(Date.now() + 2_000).toISOString() };
  }

  let runnerRunId: string;
  try {
    runnerRunId = nextApprovalRunId(state);
  } catch {
    appendAudit(
      state.audit,
      APPROVAL_COORDINATOR_ACTOR,
      'approval_wait.reconciliation_required',
      wait.sessionId,
      'denied',
      'Approval continuation dispatch was uncertain.',
    );
    saveState(state);
    return { status: 'ambiguous' };
  }
  const capability: ApprovalSessionCapability = {
    sessionId: wait.sessionId,
    userId: wait.userId,
    projectId: wait.projectId,
    workspaceId: wait.workspaceId,
    resourceRef: wait.resourceRef,
    managedThreadId: wait.managedThreadId,
  };
  state.activeApprovalRuns.set(runnerRunId, {
    capability,
    waitId: wait.id,
    continuationId: wait.continuationId,
  });

  let approvalWorkflowToken: string | undefined;
  try {
    approvalWorkflowToken = state.approvalLifecycle.issueWorkflowGrant({ ...capability, runId: runnerRunId });
  } catch {
    approvalWorkflowToken = undefined;
  }
  if (!approvalWorkflowToken || !/^[A-Za-z0-9_-]{20,16000}$/.test(approvalWorkflowToken)) {
    cleanupApprovalRun(state, runnerRunId);
    appendAudit(
      state.audit,
      APPROVAL_COORDINATOR_ACTOR,
      'approval_wait.reconciliation_required',
      wait.sessionId,
      'denied',
      'Approval continuation dispatch was uncertain.',
    );
    saveState(state);
    return { status: 'ambiguous' };
  }

  const started = startSessionRun(state, session, prompt, {
    kind: 'approval',
    wait,
    runnerRunId,
    approvalWorkflowToken,
  });
  if (!started) {
    saveState(state);
    return { status: 'ambiguous' };
  }

  return { status: 'started', runnerRunId };
}

export function resolveActiveApprovalRunCapability(
  state: RoadexState,
  runId: string,
): ApprovalSessionCapability | undefined {
  const active = state.activeApprovalRuns.get(runId);
  return active ? { ...active.capability } : undefined;
}

export function attachApprovalLifecycleBridge(state: RoadexState, bridge: ApprovalLifecycleBridge): void {
  state.approvalLifecycle = bridge;
}

export function persistApprovalRuntimeState(state: RoadexState): void {
  saveState(state);
}

export function publishApprovalCoordinatorSystemText(
  state: RoadexState,
  sessionId: string,
  message: string,
): void {
  const waitingCopy = message === 'Roadex is waiting for human approval in Admin Console. Roadex will continue automatically after verified approval.'
    || message === 'Roadex is waiting for human approval in Overview Console. Roadex will continue automatically after verified approval.';
  const terminalCopy = /^Roadex human approval result: (?:changes-requested|expired|rejected|resume-reconciliation-required|resumed|revoked|security-failure|session-closed)$/.test(message);
  if (!waitingCopy && !terminalCopy) {
    throw new Error('approval_coordinator_message_invalid');
  }
  if (!state.sessions.sessions.some((session) => session.id === sessionId)) {
    throw new Error('approval_coordinator_session_missing');
  }
  addAndPublishStreamEvents(state, [createStreamEvent(sessionId, 'system', message)]);
}

export function auditApprovalCoordinatorTransition(
  state: RoadexState,
  action: AuditEvent['action'],
  outcome: AuditEvent['outcome'],
  summary: string,
  resource: string,
): void {
  appendAudit(state.audit, APPROVAL_COORDINATOR_ACTOR, action, resource, outcome, summary);
  saveState(state);
}

type RunOrigin =
  | { kind: 'user'; user: UserProfile }
  | {
      kind: 'approval';
      wait: ApprovalWaitRecord;
      runnerRunId: string;
      approvalWorkflowToken: string;
    };

const APPROVAL_COORDINATOR_ACTOR: UserProfile = {
  id: 'roadex-approval-coordinator',
  displayName: 'Roadex approval coordinator',
  authMode: 'protected-gateway',
  roles: [],
};

function startSessionRun(
  state: RoadexState,
  session: RoadexSession,
  prompt: string,
  origin: RunOrigin,
): PromptAcceptedResponse | undefined {
  const actor = origin.kind === 'user' ? origin.user : APPROVAL_COORDINATOR_ACTOR;
  let capabilityGrant: ControlledRunnerGrant | undefined;
  try {
    capabilityGrant = state.resolveControlledRunnerGrant({
      userId: session.userId,
      workspaceId: session.workspace.id,
      workspaceRoot: session.workspace.root,
      managedThreadId: session.managedThreadId,
      codexThreadId: session.codexThreadId,
    });
  } catch {
    capabilityGrant = undefined;
  }

  let controlledOperationToken: string | undefined;
  if (origin.kind === 'user') {
    try {
      controlledOperationToken = state.issueControlledOperationToken({
        user: origin.user,
        session,
        prompt,
      });
    } catch {
      controlledOperationToken = undefined;
    }
    if (controlledOperationToken) {
      appendAudit(
        state.audit,
        origin.user,
        'controlled_operation.grant',
        pseudonymizeControlledOperationResource(session.id),
        'allowed',
        'Issued a short-lived controlled operation grant.',
      );
    }
    session.lifecycle = 'streaming';
  }

  const userApprovalWorkflowRun = origin.kind === 'user'
    ? prepareUserApprovalWorkflowRun(state, session, origin.user, capabilityGrant)
    : undefined;

  const runStartedAt = new Date().toISOString();
  session.runActivity = {
    status: 'working',
    startedAt: runStartedAt,
    lastObservedAt: runStartedAt,
  };
  touchSession(session);
  const started = appendAudit(
    state.audit,
    actor,
    'session.prompt',
    session.id,
    'allowed',
    origin.kind === 'user' ? 'Accepted prompt for Codex runner.' : 'Accepted verified approval continuation.',
  );
  addAndPublishStreamEvents(state, [createStreamEvent(session.id, origin.kind === 'user' ? 'user' : 'system', prompt)]);
  const controller = new AbortController();
  state.activeRuns.set(session.id, controller);

  let runnerPromise: Promise<RunnerPromptResult>;
  try {
    runnerPromise = state.runner.runPrompt({
      session,
      prompt,
      signal: controller.signal,
      capabilityGrant,
      controlledOperationToken,
      approvalWorkflowToken: origin.kind === 'approval'
        ? origin.approvalWorkflowToken
        : userApprovalWorkflowRun?.approvalWorkflowToken,
      runId: origin.kind === 'approval' ? origin.runnerRunId : userApprovalWorkflowRun?.runnerRunId,
      onActivity: () => {
        if (!session.runActivity) return;
        if (origin.kind === 'user' && session.lifecycle !== 'streaming') return;
        if (origin.kind === 'approval' && session.lifecycle !== 'paused') return;
        session.runActivity.lastObservedAt = new Date().toISOString();
        touchSession(session);
      },
      onEvent: (event) => {
        if (session.runActivity) {
          session.runActivity.lastObservedAt = event.at;
        }
        addAndPublishStreamEvents(state, [event]);
      },
    });
  } catch (error) {
    if (origin.kind === 'user') {
      state.activeRuns.delete(session.id);
      session.runActivity = undefined;
      if (userApprovalWorkflowRun) cleanupApprovalRun(state, userApprovalWorkflowRun.runnerRunId);
      touchSession(session);
      saveState(state);
      throw error;
    }
    state.activeRuns.delete(session.id);
    session.runActivity = undefined;
    if (origin.kind === 'approval') {
      cleanupApprovalRun(state, origin.runnerRunId);
      appendAudit(
        state.audit,
        actor,
        'session.runner_failed',
        session.id,
        'denied',
        'runner_exception',
      );
    }
    touchSession(session);
    saveState(state);
    return undefined;
  }

  if (origin.kind === 'user') {
    void runnerPromise
      .then((result) => settleUserRun(state, session, origin.user, result))
      .catch((error: unknown) => failUserRun(state, session, origin.user, error))
      .finally(() => {
        state.activeRuns.delete(session.id);
        if (userApprovalWorkflowRun) cleanupApprovalRun(state, userApprovalWorkflowRun.runnerRunId);
        saveState(state);
      });
  } else {
    const settlement = runnerPromise
      .then(
        (result) => deferApprovalSettlement(() => settleApprovalRun(state, session, origin, result)),
        () => deferApprovalSettlement(() => settleUncertainApprovalRun(state, session, origin)),
      )
      .catch(() => deferApprovalSettlement(() => settleUncertainApprovalRun(state, session, origin)));
    void settlement
      .finally(() => {
        session.runActivity = undefined;
        state.activeRuns.delete(session.id);
        cleanupApprovalRun(state, origin.runnerRunId);
        touchSession(session);
        saveState(state);
      })
      .catch(() => undefined);
  }
  saveState(state);
  return { accepted: true, auditEvent: started };
}

function settleUserRun(
  state: RoadexState,
  session: RoadexSession,
  user: UserProfile,
  result: RunnerPromptResult,
): void {
  if (session.lifecycle === 'closed') return;
  if (session.managedThreadId && result.codexThreadId && result.codexThreadId !== session.managedThreadId) {
    if (markActiveApprovalWaitSecurityFailure(state, session)) {
      appendAudit(
        state.audit,
        user,
        'security.denied',
        session.id,
        'denied',
        'Managed Codex runner returned a mismatched thread identity.',
      );
      saveState(state);
      addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
      return;
    }
    session.lifecycle = 'blocked';
    session.runActivity = undefined;
    touchSession(session);
    appendAudit(
      state.audit,
      user,
      'security.denied',
      session.id,
      'denied',
      'Managed Codex runner returned a mismatched thread identity.',
    );
    addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
    return;
  }
  if (preserveActiveApprovalWait(state, session)) return;
  updateCodexThreadId(session, result.codexThreadId);
  if (result.ok) {
    session.lifecycle = 'ready';
    session.runActivity = undefined;
    touchSession(session);
    appendAudit(state.audit, user, 'session.runner_complete', session.id, 'allowed', 'Codex runner completed.');
  } else if (result.reason === 'runner_cancelled') {
    session.lifecycle = 'ready';
    session.runActivity = undefined;
    touchSession(session);
    appendAudit(state.audit, user, 'session.cancel', session.id, 'allowed', 'Codex runner was cancelled.');
  } else {
    session.lifecycle = 'blocked';
    session.runActivity = undefined;
    touchSession(session);
    appendAudit(state.audit, user, 'session.runner_failed', session.id, 'denied', result.reason);
    addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
  }
}

function failUserRun(state: RoadexState, session: RoadexSession, user: UserProfile, error: unknown): void {
  if (session.lifecycle === 'closed') return;
  if (preserveActiveApprovalWait(state, session)) return;
  session.lifecycle = 'blocked';
  session.runActivity = undefined;
  touchSession(session);
  appendAudit(
    state.audit,
    user,
    'session.runner_failed',
    session.id,
    'denied',
    error instanceof Error ? error.message : 'runner_exception',
  );
  addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
}

function preserveActiveApprovalWait(state: RoadexState, session: RoadexSession): boolean {
  const active = state.approvalWaits.some(
    (wait) => wait.sessionId === session.id && isActiveApprovalWait(wait.state),
  );
  if (!active) return false;
  session.lifecycle = 'paused';
  session.runActivity = undefined;
  touchSession(session);
  return true;
}

function markActiveApprovalWaitSecurityFailure(state: RoadexState, session: RoadexSession): boolean {
  const active = state.approvalWaits
    .filter((wait) => wait.sessionId === session.id && isActiveApprovalWait(wait.state))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  if (active.length === 0) return false;
  const now = new Date().toISOString();
  for (const wait of active) {
    wait.state = 'security-failure';
    wait.updatedAt = now;
    wait.nextCheckAt = now;
    delete wait.dispatchReservedAt;
    delete wait.runnerRunId;
    appendAudit(
      state.audit,
      APPROVAL_COORDINATOR_ACTOR,
      'approval_wait.security_failure',
      wait.sessionId,
      'denied',
      `wait=${wait.id};state=security-failure;console=${wait.consoleSurface}`,
    );
  }
  const current = active[0];
  session.lifecycle = 'paused';
  session.runActivity = undefined;
  session.waitingApproval = {
    waitId: current.id,
    approvalRef: current.approvalRef,
    subject: current.subject,
    consoleSurface: current.consoleSurface,
    state: 'security-failure',
    updatedAt: current.updatedAt,
  };
  touchSession(session);
  return true;
}

async function settleApprovalRun(
  state: RoadexState,
  session: RoadexSession,
  origin: Extract<RunOrigin, { kind: 'approval' }>,
  result: RunnerPromptResult,
): Promise<void> {
  const outcome: ApprovalContinuationCompletionOutcome = result.ok
    ? result.codexThreadId
      ? { status: 'succeeded', managedThreadId: result.codexThreadId }
      : { status: 'uncertain' }
    : result.codexThreadId
      ? { status: 'failed', managedThreadId: result.codexThreadId }
      : { status: 'failed' };
  const completion = await state.approvalLifecycle.completeContinuation(
    origin.wait.continuationId,
    origin.runnerRunId,
    outcome,
  );
  if (session.lifecycle === 'closed') return;
  if (result.ok && result.codexThreadId === origin.wait.managedThreadId) {
    if (completion?.status !== 'resumed') return;
    updateCodexThreadId(session, result.codexThreadId);
    appendAudit(
      state.audit,
      APPROVAL_COORDINATOR_ACTOR,
      'session.runner_complete',
      session.id,
      'allowed',
      'Approval continuation runner completed.',
    );
    return;
  }
  appendAudit(
    state.audit,
    APPROVAL_COORDINATOR_ACTOR,
    result.ok ? 'security.denied' : 'session.runner_failed',
    session.id,
    'denied',
    result.ok ? 'Approval continuation thread identity mismatch.' : 'approval_runner_failed',
  );
  addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
}

function deferApprovalSettlement(work: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      void work().then(resolve, reject);
    });
  });
}

async function settleUncertainApprovalRun(
  state: RoadexState,
  session: RoadexSession,
  origin: Extract<RunOrigin, { kind: 'approval' }>,
): Promise<void> {
  try {
    await state.approvalLifecycle.completeContinuation(
      origin.wait.continuationId,
      origin.runnerRunId,
      { status: 'uncertain' },
    );
  } catch {
    // Completion failures remain reconciliation work and are never exposed to the stream or audit.
  }
  if (session.lifecycle === 'closed') return;
  appendAudit(
    state.audit,
    APPROVAL_COORDINATOR_ACTOR,
    'session.runner_failed',
    session.id,
    'denied',
    'runner_exception',
  );
  addAndPublishStreamEvents(state, [createStreamEvent(session.id, 'system', 'Codex runner failed.')]);
}

function hasActiveApprovalWait(state: RoadexState, sessionId: string): boolean {
  const persistedActive = state.approvalWaits.some(
    (wait) => wait.sessionId === sessionId && isActiveApprovalWait(wait.state),
  );
  try {
    return persistedActive || state.approvalLifecycle.hasActiveWait(sessionId);
  } catch {
    return persistedActive;
  }
}

function denyApprovalDispatch(
  state: RoadexState,
  sessionId: string,
  reason: Extract<ApprovalContinuationDispatchResult, { status: 'denied' }>['reason'],
): ApprovalContinuationDispatchResult {
  appendAudit(
    state.audit,
    APPROVAL_COORDINATOR_ACTOR,
    'security.denied',
    sessionId,
    'denied',
    'Approval continuation dispatch denied.',
  );
  saveState(state);
  return { status: 'denied', reason };
}

function nextApprovalRunId(state: RoadexState): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = state.generateApprovalRunId();
    if (!/^run-[0-9a-f]{32}$/.test(runId)) continue;
    if (!state.activeApprovalRuns.has(runId)) return runId;
  }
  throw new Error('approval_run_id_unavailable');
}

function prepareUserApprovalWorkflowRun(
  state: RoadexState,
  session: RoadexSession,
  user: UserProfile,
  capabilityGrant: ControlledRunnerGrant | undefined,
): UserApprovalWorkflowRun | undefined {
  if (
    !capabilityGrant
    || capabilityGrant.status !== 'active'
    || capabilityGrant.userId !== user.id
    || capabilityGrant.userId !== session.userId
    || capabilityGrant.workspaceId !== session.workspace.id
    || capabilityGrant.workspaceRoot !== session.workspace.root
    || !session.managedThreadId
    || session.managedThreadId !== session.codexThreadId
    || capabilityGrant.managedThreadId !== session.managedThreadId
    || !isBoundedApprovalResource(capabilityGrant.operationId)
  ) {
    return undefined;
  }

  let runnerRunId: string;
  try {
    runnerRunId = nextApprovalRunId(state);
  } catch {
    return undefined;
  }
  const capability: ApprovalSessionCapability = {
    sessionId: session.id,
    userId: session.userId,
    projectId: session.workspace.id,
    workspaceId: session.workspace.id,
    resourceRef: capabilityGrant.operationId,
    managedThreadId: session.managedThreadId,
  };
  state.activeApprovalRuns.set(runnerRunId, {
    capability,
  });

  let approvalWorkflowToken: string | undefined;
  try {
    approvalWorkflowToken = state.approvalLifecycle.issueWorkflowGrant({ ...capability, runId: runnerRunId });
  } catch {
    approvalWorkflowToken = undefined;
  }
  if (!approvalWorkflowToken || !/^[A-Za-z0-9_-]{20,16000}$/.test(approvalWorkflowToken)) {
    cleanupApprovalRun(state, runnerRunId);
    return undefined;
  }
  return { runnerRunId, approvalWorkflowToken };
}

function isBoundedApprovalResource(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint >= 0x80 && codePoint <= 0x9f) return false;
  }
  return true;
}

function cleanupApprovalRun(state: RoadexState, runId: string): void {
  state.activeApprovalRuns.delete(runId);
  try {
    state.approvalLifecycle.revokeWorkflowGrant(runId);
  } catch {
    // Run capability removal is authoritative; grant revocation failures are not exposed.
  }
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
  if (session.lifecycle === 'blocked' || session.lifecycle === 'paused' || session.lifecycle === 'ready') {
    const recovered = recoverSession(state, user, sessionId);
    return recovered?.recovered
      ? { reopened: true, session: recovered.session, auditEvent: recovered.auditEvent }
      : {
          reopened: false,
          gate: 'session-state',
          reason: recovered?.reason === 'active-runner'
            ? 'Active work must finish or be cancelled before recovery.'
            : 'Session recovery is unavailable.',
        };
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

export function recoverSession(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
): RecoverSessionResponse | undefined {
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session)) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Recover denied: session is unavailable.');
    saveState(state);
    return undefined;
  }
  if (state.activeRuns.has(sessionId)) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Recover denied: active runner present.');
    saveState(state);
    return { recovered: false, reason: 'active-runner' };
  }
  if (session.lifecycle !== 'blocked' && session.lifecycle !== 'paused' && session.lifecycle !== 'ready') {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Recover denied: lifecycle is not recoverable.');
    saveState(state);
    return { recovered: false, reason: 'invalid-lifecycle' };
  }
  const workspaceDecision = resolveWorkspaceForUser(user, session.workspace.id);
  if (!workspaceDecision.ok || workspaceDecision.workspace.root !== session.workspace.root) {
    appendAudit(state.audit, user, 'security.denied', sessionId, 'denied', 'Recover denied: workspace is unavailable.');
    saveState(state);
    return { recovered: false, reason: 'workspace-unavailable' };
  }

  const alreadyReady = session.lifecycle === 'ready';
  session.lifecycle = 'ready';
  session.runActivity = undefined;
  touchSession(session);
  const auditEvent = appendAudit(
    state.audit,
    user,
    'session.recover',
    sessionId,
    'allowed',
    alreadyReady
      ? 'Recovery confirmed session was already ready without starting a runner.'
      : 'Recovered stopped session without starting a runner.',
  );
  saveState(state);
  return { recovered: true, session, auditEvent };
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

export function approveDeviceBridgeRequest(
  state: RoadexState,
  user: UserProfile,
  requestId: string,
): DeviceBridgeApprovalResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  if (!deviceBridgeApprovalEnabled()) {
    if (!auditHmacKey) return publicDeviceBridgeApprovalDenial('device-bridge');
    return denyDeviceBridgeApproval(state, user, requestId, 'device-bridge', auditHmacKey);
  }
  if (!auditHmacKey) return publicDeviceBridgeApprovalDenial('audit');
  if (user.authMode !== 'protected-gateway' || !canAuthorizeInventoryBinding(user)) {
    return denyDeviceBridgeApproval(state, user, requestId, 'auth', auditHmacKey);
  }

  const request = state.deviceBridgeRequests.get(requestId);
  if (!request) return denyDeviceBridgeApproval(state, user, requestId, 'request', auditHmacKey);
  if (request.userId !== user.id) {
    return denyDeviceBridgeApproval(state, user, request.id, 'auth', auditHmacKey);
  }

  const existingApproval = [...state.deviceBridgeApprovals.values()].some(
    (approval) => approval.requestId === request.id,
  );
  if (request.status !== 'pending' || existingApproval || expiredIso(request.expiresAt)) {
    return denyDeviceBridgeApproval(state, user, request.id, 'request', auditHmacKey);
  }

  const session = getOwnedSession(state.sessions, request.userId, request.sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready') {
    return denyDeviceBridgeApproval(state, user, request.id, 'session', auditHmacKey);
  }
  if (session.workspace.id !== request.projectId) {
    return denyDeviceBridgeApproval(state, user, request.id, 'session', auditHmacKey);
  }

  const artifact = state.deviceArtifacts.get(request.artifactId);
  if (
    !artifact ||
    artifact.status !== 'active' ||
    expiredIso(artifact.expiresAt) ||
    artifact.projectId !== request.projectId ||
    artifact.sessionId !== request.sessionId ||
    artifact.sha256.toLowerCase() !== request.artifactSha256
  ) {
    return denyDeviceBridgeApproval(state, user, request.id, 'artifact', auditHmacKey);
  }

  const binding = state.deviceInventoryBindings.get(request.inventoryBindingId);
  if (
    !validActiveInventoryBindingForRequest(binding, request.projectId) ||
    binding.deviceIdentityTag.toLowerCase() !== request.deviceIdentityTag
  ) {
    return denyDeviceBridgeApproval(state, user, request.id, 'inventory', auditHmacKey);
  }

  const createdAt = new Date().toISOString();
  const approval: DeviceBridgeApprovalRecord = {
    id: `bridge-approval-${randomUUID()}`,
    requestId: request.id,
    userId: request.userId,
    sessionId: request.sessionId,
    projectId: request.projectId,
    artifactId: request.artifactId,
    artifactSha256: request.artifactSha256,
    inventoryBindingId: request.inventoryBindingId,
    deviceIdentityTag: request.deviceIdentityTag,
    credentialDigest: createHash('sha256').update(randomBytes(32)).digest('hex'),
    operation: 'esp32.flash',
    status: 'pending',
    createdAt,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const approvedRequest: DeviceBridgeRequestRecord = {
    ...request,
    status: 'approved',
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.approval',
    request.id,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'approved',
      userId: user.id,
      sessionId: request.sessionId,
      requestId: request.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceBridgeRequests: [...state.deviceBridgeRequests.values()].map((record) =>
      record.id === request.id ? approvedRequest : record,
    ),
    deviceBridgeApprovals: [...state.deviceBridgeApprovals.values(), approval],
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceBridgeRequests.set(request.id, approvedRequest);
  state.deviceBridgeApprovals.set(approval.id, approval);
  state.audit.events.push(auditEvent);
  return { ok: true, approval: publicDeviceBridgeApproval(approval) };
}

export function startDeviceBridgeProbe(
  state: RoadexState,
  user: UserProfile,
  approvalId: string,
): DeviceBridgeProbeStartResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  if (!deviceBridgeProbeEnabled() || !auditHmacKey) {
    return publicDeviceBridgeProbeDenial('device-bridge');
  }
  if (user.authMode !== 'protected-gateway' || !canAuthorizeInventoryBinding(user)) {
    return denyDeviceBridgeProbe(state, user, approvalId, 'auth', auditHmacKey);
  }
  const approval = state.deviceBridgeApprovals.get(approvalId);
  if (!approval || approval.userId !== user.id || approval.status !== 'pending' || expiredIso(approval.expiresAt)) {
    return denyDeviceBridgeProbe(state, user, approvalId, 'approval', auditHmacKey);
  }
  if (!usbProfileAllowsOperation(state, approval.projectId, 'esp32.flash')) {
    return denyDeviceBridgeProbe(state, user, approvalId, 'device-profile', auditHmacKey);
  }
  const session = getOwnedSession(state.sessions, user.id, approval.sessionId);
  const artifact = state.deviceArtifacts.get(approval.artifactId);
  const binding = state.deviceInventoryBindings.get(approval.inventoryBindingId);
  const duplicate = [...state.deviceBridgeOperations.values()].some((operation) => operation.approvalId === approval.id);
  if (
    !session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready' ||
    session.workspace.id !== approval.projectId || duplicate ||
    !artifact || artifact.status !== 'active' || expiredIso(artifact.expiresAt) ||
    artifact.sessionId !== approval.sessionId || artifact.projectId !== approval.projectId ||
    artifact.sha256.toLowerCase() !== approval.artifactSha256 ||
    !validActiveInventoryBindingForRequest(binding, approval.projectId) ||
    binding.deviceIdentityTag.toLowerCase() !== approval.deviceIdentityTag || !binding.deviceMacTag
  ) {
    return denyDeviceBridgeProbe(state, user, approval.id, 'state', auditHmacKey);
  }

  const createdAt = new Date().toISOString();
  const operation: DeviceBridgeOperationRecord = {
    id: `bridge-operation-${randomUUID()}`,
    approvalId: approval.id,
    userId: user.id,
    sessionId: approval.sessionId,
    projectId: approval.projectId,
    artifactId: approval.artifactId,
    artifactSha256: approval.artifactSha256,
    inventoryBindingId: approval.inventoryBindingId,
    deviceIdentityTag: approval.deviceIdentityTag,
    operation: 'esp32.flash',
    phase: 'probe',
    credentialDigest: createHash('sha256').update(randomBytes(32)).digest('hex'),
    nextEventSequence: 0,
    phaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    reportingExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
  };
  const consumedApproval: DeviceBridgeApprovalRecord = { ...approval, status: 'consumed' };
  const auditEvent = createBridgeAuditEvent(
    state, auditHmacKey, user, 'device_bridge.operation_probe', operation.id, 'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: 'probe_started', userId: user.id, sessionId: operation.sessionId, requestId: operation.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceBridgeApprovals: [...state.deviceBridgeApprovals.values()].map((record) =>
      record.id === approval.id ? consumedApproval : record),
    deviceBridgeOperations: [...state.deviceBridgeOperations.values(), operation],
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceBridgeApprovals.set(approval.id, consumedApproval);
  state.deviceBridgeOperations.set(operation.id, operation);
  state.audit.events.push(auditEvent);
  return { ok: true, operation: publicDeviceBridgeOperation(operation) };
}

export function submitDeviceBridgeProbe(
  state: RoadexState,
  user: UserProfile,
  operationId: string,
  payload: unknown,
): DeviceBridgeProbeResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const identityHmacKey = deviceBridgeIdentityHmacKey();
  if (!deviceBridgeProbeEnabled() || !auditHmacKey || !identityHmacKey) {
    return publicDeviceBridgeProbeDenial('device-bridge');
  }
  const parsed = parseDeviceBridgeProbePayload(payload);
  const operation = state.deviceBridgeOperations.get(operationId);
  if (
    user.authMode !== 'protected-gateway' || !parsed || !operation || operation.userId !== user.id ||
    operation.phase !== 'probe' || expiredIso(operation.phaseExpiresAt) ||
    !usbProfileAllowsOperation(state, operation.projectId, 'esp32.flash')
  ) {
    return denyDeviceBridgeProbe(state, user, operationId, 'auth', auditHmacKey);
  }
  const session = getOwnedSession(state.sessions, user.id, operation.sessionId);
  const artifact = state.deviceArtifacts.get(operation.artifactId);
  const binding = state.deviceInventoryBindings.get(operation.inventoryBindingId);
  const observedMacTag = deviceMacTag(identityHmacKey, operation.projectId, parsed.deviceMac);
  const identityMatches = Boolean(
    validActiveInventoryBindingForRequest(binding, operation.projectId) &&
    binding.deviceIdentityTag.toLowerCase() === operation.deviceIdentityTag &&
    binding.deviceMacTag === observedMacTag,
  );
  const artifactMatches = Boolean(
    artifact && artifact.status === 'active' && !expiredIso(artifact.expiresAt) &&
    artifact.sessionId === operation.sessionId && artifact.projectId === operation.projectId &&
    artifact.sha256.toLowerCase() === operation.artifactSha256 &&
    parsed.artifactSha256 === operation.artifactSha256,
  );
  const sessionMatches = Boolean(
    session && isManagedSessionAuthorized(state, user, session) && session.lifecycle === 'ready' &&
    session.workspace.id === operation.projectId,
  );
  const verified = identityMatches && artifactMatches && sessionMatches;
  const updated: DeviceBridgeOperationRecord = {
    ...operation,
    phase: verified ? 'verified' : 'failed',
    ...(verified ? {
      actualDeviceIdentityTag: observedMacTag,
      verifiedArtifactSha256: parsed.artifactSha256,
    } : {}),
    updatedAt: new Date().toISOString(),
  };
  const classification = verified
    ? 'probe_verified'
    : !identityMatches ? 'identity_mismatch' : !artifactMatches ? 'artifact_mismatch' : 'session_mismatch';
  const auditEvent = createBridgeAuditEvent(
    state, auditHmacKey, user, 'device_bridge.operation_probe', operation.id, verified ? 'allowed' : 'denied',
    bridgeAuditSummary(auditHmacKey, {
      classification, userId: user.id, sessionId: operation.sessionId, requestId: operation.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceBridgeOperations: [...state.deviceBridgeOperations.values()].map((record) =>
      record.id === operation.id ? updated : record),
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceBridgeOperations.set(operation.id, updated);
  state.audit.events.push(auditEvent);
  return verified
    ? { ok: true, operation: publicDeviceBridgeOperation(updated) }
    : publicDeviceBridgeProbeDenial(classification);
}

export function confirmDeviceBridgeProbe(
  state: RoadexState,
  user: UserProfile,
  operationId: string,
  payload: unknown,
): DeviceBridgeProbeResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const operation = state.deviceBridgeOperations.get(operationId);
  const session = operation && getOwnedSession(state.sessions, user.id, operation.sessionId);
  const artifact = operation && state.deviceArtifacts.get(operation.artifactId);
  const binding = operation && state.deviceInventoryBindings.get(operation.inventoryBindingId);
  if (
    !deviceBridgeProbeEnabled() || !auditHmacKey || user.authMode !== 'protected-gateway' ||
    !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0 ||
    !operation || operation.userId !== user.id || operation.phase !== 'verified' || expiredIso(operation.phaseExpiresAt) ||
    !usbProfileAllowsOperation(state, operation.projectId, 'esp32.flash') ||
    !session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready' ||
    !artifact || artifact.status !== 'active' || expiredIso(artifact.expiresAt) ||
    artifact.sha256 !== operation.verifiedArtifactSha256 ||
    !validActiveInventoryBindingForRequest(binding, operation.projectId) ||
    binding.deviceIdentityTag !== operation.deviceIdentityTag || binding.deviceMacTag !== operation.actualDeviceIdentityTag
  ) return denyDeviceBridgeProbe(state, user, operationId, 'confirmation', auditHmacKey || '');
  const updated = { ...operation, phase: 'confirmation' as const, phaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() };
  const auditEvent = createBridgeAuditEvent(state, auditHmacKey, user, 'device_bridge.operation_probe', operation.id, 'allowed', bridgeAuditSummary(auditHmacKey, { classification: 'confirmation_recorded', userId: user.id, sessionId: operation.sessionId, requestId: operation.id }));
  persistStateSnapshot(state, { deviceBridgeOperations: [...state.deviceBridgeOperations.values()].map((record) => record.id === operation.id ? updated : record), auditEvents: [...state.audit.events, auditEvent] });
  state.deviceBridgeOperations.set(operation.id, updated);
  state.audit.events.push(auditEvent);
  return { ok: true, operation: publicDeviceBridgeOperation(updated) };
}

export function deliverConfirmedDeviceArtifact(
  state: RoadexState,
  user: UserProfile,
  operationId: string,
): { ok: true; bytes: Buffer; sha256: string } | { ok: false } {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const operation = state.deviceBridgeOperations.get(operationId);
  const session = operation && getOwnedSession(state.sessions, user.id, operation.sessionId);
  const artifact = operation && state.deviceArtifacts.get(operation.artifactId);
  const binding = operation && state.deviceInventoryBindings.get(operation.inventoryBindingId);
  if (
    !deviceBridgeProbeEnabled() || !auditHmacKey || user.authMode !== 'protected-gateway' ||
    !operation || operation.userId !== user.id || operation.phase !== 'confirmation' || expiredIso(operation.phaseExpiresAt) ||
    !usbProfileAllowsOperation(state, operation.projectId, 'esp32.flash') ||
    !session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready' ||
    !artifact || artifact.status !== 'active' || expiredIso(artifact.expiresAt) ||
    artifact.projectId !== operation.projectId || artifact.sessionId !== operation.sessionId ||
    artifact.sha256 !== operation.artifactSha256 || artifact.sha256 !== operation.verifiedArtifactSha256 ||
    !validActiveInventoryBindingForRequest(binding, operation.projectId) ||
    binding.deviceIdentityTag !== operation.deviceIdentityTag || binding.deviceMacTag !== operation.actualDeviceIdentityTag
  ) return { ok: false };

  const bytes = readDeviceArtifact(artifact.storageReference, artifact.byteLength, artifact.sha256);
  if (!bytes) return { ok: false };
  const updated: DeviceBridgeOperationRecord = {
    ...operation,
    confirmationChallengeDigest: createHash('sha256').update(randomBytes(32)).digest('hex'),
    updatedAt: new Date().toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(state, auditHmacKey, user, 'device_bridge.artifact_delivery', operation.id, 'allowed', bridgeAuditSummary(auditHmacKey, { classification: 'artifact_delivered', userId: user.id, sessionId: operation.sessionId, requestId: operation.id }));
  persistStateSnapshot(state, {
    deviceBridgeOperations: [...state.deviceBridgeOperations.values()].map((record) => record.id === operation.id ? updated : record),
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceBridgeOperations.set(operation.id, updated);
  state.audit.events.push(auditEvent);
  return { ok: true, bytes, sha256: artifact.sha256 };
}

export function authorizeDeviceBridgeWrite(
  state: RoadexState,
  user: UserProfile,
  operationId: string,
  payload: unknown,
): DeviceBridgeWriteAuthorizationResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const identityHmacKey = deviceBridgeIdentityHmacKey();
  const operation = state.deviceBridgeOperations.get(operationId);
  const session = operation && getOwnedSession(state.sessions, user.id, operation.sessionId);
  const artifact = operation && state.deviceArtifacts.get(operation.artifactId);
  const binding = operation && state.deviceInventoryBindings.get(operation.inventoryBindingId);
  const parsed = parseWriteAuthorizationPayload(payload);
  const writeTokenDigest = parsed && createHash('sha256').update(parsed.writeToken).digest('hex');
  if (
    deviceBridgeWriteEnabled() && auditHmacKey && identityHmacKey && user.authMode === 'protected-gateway' && parsed && writeTokenDigest &&
    operation?.userId === user.id && operation.phase === 'destructive' && operation.destructiveNonceDigest &&
    usbProfileAllowsOperation(state, operation.projectId, 'esp32.flash') &&
    timingSafeEqual(Buffer.from(writeTokenDigest), Buffer.from(operation.destructiveNonceDigest))
  ) return { ok: true, operation: publicDeviceBridgeOperation(operation) };
  if (
    !deviceBridgeWriteEnabled() || !auditHmacKey || !identityHmacKey || user.authMode !== 'protected-gateway' || !parsed ||
    !operation || operation.userId !== user.id || operation.phase !== 'confirmation' || expiredIso(operation.phaseExpiresAt) ||
    !usbProfileAllowsOperation(state, operation.projectId, 'esp32.flash') ||
    !operation.confirmationChallengeDigest || parsed.artifactSha256 !== operation.verifiedArtifactSha256 ||
    !session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready' ||
    !artifact || artifact.status !== 'active' || expiredIso(artifact.expiresAt) || artifact.sha256 !== parsed.artifactSha256 ||
    !readDeviceArtifact(artifact.storageReference, artifact.byteLength, artifact.sha256) ||
    !validActiveInventoryBindingForRequest(binding, operation.projectId) ||
    binding.deviceIdentityTag !== operation.deviceIdentityTag || binding.deviceMacTag !== operation.actualDeviceIdentityTag ||
    deviceMacTag(identityHmacKey, operation.projectId, parsed.deviceMac) !== operation.actualDeviceIdentityTag
  ) return denyDeviceBridgeProbe(state, user, operationId, 'write_authorization', auditHmacKey || '');
  const updated: DeviceBridgeOperationRecord = {
    ...operation,
    phase: 'destructive',
    confirmationChallengeDigest: undefined,
    destructiveNonceDigest: writeTokenDigest,
    nextEventSequence: operation.nextEventSequence + 1,
    phaseExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return persistDeviceBridgeWriteTransition(state, user, operation, updated, auditHmacKey, 'write_authorized', 'allowed');
}

export function reportDeviceBridgeWrite(
  state: RoadexState,
  user: UserProfile,
  operationId: string,
  payload: unknown,
): DeviceBridgeProbeResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const operation = state.deviceBridgeOperations.get(operationId);
  const parsed = parseWriteReportPayload(payload);
  const writeTokenDigest = parsed && createHash('sha256').update(parsed.writeToken).digest('hex');
  if (
    deviceBridgeWriteEnabled() && auditHmacKey && user.authMode === 'protected-gateway' && parsed && writeTokenDigest &&
    operation?.userId === user.id && operation.phase === parsed.outcome && operation.destructiveNonceDigest &&
    timingSafeEqual(Buffer.from(writeTokenDigest), Buffer.from(operation.destructiveNonceDigest))
  ) return { ok: true, operation: publicDeviceBridgeOperation(operation) };
  if (
    !deviceBridgeWriteEnabled() || !auditHmacKey || user.authMode !== 'protected-gateway' || !parsed || !writeTokenDigest ||
    !operation || operation.userId !== user.id || operation.phase !== 'destructive' ||
    !operation.destructiveNonceDigest || expiredIso(operation.reportingExpiresAt) ||
    parsed.artifactSha256 !== operation.verifiedArtifactSha256 ||
    !timingSafeEqual(
      Buffer.from(writeTokenDigest),
      Buffer.from(operation.destructiveNonceDigest),
    )
  ) return denyDeviceBridgeProbe(state, user, operationId, 'write_report', auditHmacKey || '');
  const updated: DeviceBridgeOperationRecord = {
    ...operation,
    phase: parsed.outcome,
    nextEventSequence: operation.nextEventSequence + 1,
    updatedAt: new Date().toISOString(),
  };
  return persistDeviceBridgeWriteTransition(
    state, user, operation, updated, auditHmacKey,
    parsed.outcome === 'completed' ? 'write_completed' : 'write_failed',
    parsed.outcome === 'completed' ? 'allowed' : 'denied',
  );
}

function persistDeviceBridgeWriteTransition(
  state: RoadexState,
  user: UserProfile,
  operation: DeviceBridgeOperationRecord,
  updated: DeviceBridgeOperationRecord,
  auditHmacKey: string,
  classification: string,
  outcome: 'allowed' | 'denied',
): DeviceBridgeProbeResponse {
  const auditEvent = createBridgeAuditEvent(state, auditHmacKey, user, 'device_bridge.operation_write', operation.id, outcome, bridgeAuditSummary(auditHmacKey, { classification, userId: user.id, sessionId: operation.sessionId, requestId: operation.id }));
  persistStateSnapshot(state, {
    deviceBridgeOperations: [...state.deviceBridgeOperations.values()].map((record) => record.id === operation.id ? updated : record),
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceBridgeOperations.set(operation.id, updated);
  state.audit.events.push(auditEvent);
  return { ok: true, operation: publicDeviceBridgeOperation(updated) };
}

export function observeDeviceDescriptor(
  state: RoadexState,
  user: UserProfile,
  sessionId: string,
  payload: unknown,
): DeviceDescriptorObservationResponse {
  const auditHmacKey = deviceBridgeAuditHmacKey();
  const descriptorHmacKey = deviceBridgeDescriptorHmacKey();
  if (!deviceBridgeDescriptorObservationEnabled()) {
    return denyDescriptorObservation(state, user, sessionId, 'device-bridge', auditHmacKey);
  }
  if (!auditHmacKey || !descriptorHmacKey) {
    return denyDescriptorObservation(state, user, sessionId, 'audit', auditHmacKey);
  }
  if (user.authMode !== 'protected-gateway' || !canAuthorizeInventoryBinding(user)) {
    return denyDescriptorObservation(state, user, sessionId, 'auth', auditHmacKey);
  }
  const session = getOwnedSession(state.sessions, user.id, sessionId);
  if (!session || !isManagedSessionAuthorized(state, user, session) || session.lifecycle !== 'ready') {
    return denyDescriptorObservation(state, user, sessionId, 'session', auditHmacKey);
  }
  const parsed = parseDescriptorObservationPayload(payload);
  if (!parsed.ok) {
    return denyDescriptorObservation(state, user, sessionId, 'schema', auditHmacKey);
  }
  const requiredUsbOperation = parsed.payload.deviceMac ? 'esp32.identity' : 'observe';
  if (!usbProfileAllowsDescriptor(
    state, session.workspace.id, requiredUsbOperation, parsed.payload.vendorId, parsed.payload.productId,
  )) return denyDescriptorObservation(state, user, sessionId, 'device-bridge', auditHmacKey);
  const binding = state.deviceInventoryBindings.get(parsed.payload.inventoryBindingId);
  if (!validActiveInventoryBindingForRequest(binding, session.workspace.id)) {
    return denyDescriptorObservation(state, user, sessionId, 'inventory', auditHmacKey);
  }
  const recentCount = [...state.deviceDescriptorObservations.values()].filter(
    (record) => record.sessionId === session.id && Date.parse(record.createdAt) > Date.now() - 60_000,
  ).length;
  if (recentCount >= 10) {
    return denyDescriptorObservation(state, user, sessionId, 'quota', auditHmacKey);
  }

  const serial = parsed.payload.serialNumber?.normalize('NFC').trim().toLowerCase() ?? 'none';
  const descriptorFingerprint = createHmac('sha256', descriptorHmacKey)
    .update(`roadex-usb-descriptor:v1:${parsed.payload.vendorId}:${parsed.payload.productId}:${serial}`)
    .digest('hex');
  const identityHmacKey = deviceBridgeIdentityHmacKey();
  const observedMacTag = parsed.payload.deviceMac && identityHmacKey
    ? deviceMacTag(identityHmacKey, session.workspace.id, parsed.payload.deviceMac)
    : undefined;
  const verification = !observedMacTag || !binding.deviceMacTag
    ? 'unverified'
    : observedMacTag === binding.deviceMacTag ? 'verified' : 'mismatch';
  const observation: DeviceDescriptorObservationRecord = {
    id: `descriptor-observation-${randomUUID()}`,
    userId: user.id,
    sessionId: session.id,
    projectId: session.workspace.id,
    inventoryBindingId: binding.id,
    vendorId: parsed.payload.vendorId,
    productId: parsed.payload.productId,
    descriptorFingerprint,
    status: 'observed',
    verification,
    createdAt: new Date().toISOString(),
  };
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'device_bridge.descriptor_observation',
    session.id,
    'allowed',
    bridgeAuditSummary(auditHmacKey, {
      classification: `descriptor_${verification}`,
      userId: user.id,
      sessionId: session.id,
      requestId: observation.id,
    }),
  );
  persistStateSnapshot(state, {
    deviceDescriptorObservations: [...state.deviceDescriptorObservations.values(), observation],
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.deviceDescriptorObservations.set(observation.id, observation);
  state.audit.events.push(auditEvent);
  return { ok: true, observation: publicDescriptorObservation(observation) };
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
  let storageReference: string;
  try {
    storageReference = storeDeviceArtifact(artifactFile.bytes, artifactFile.metadata.sha256);
  } catch {
    return denyDeviceBridgeMetadata(state, user, session.id, 'audit', auditHmacKey);
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
    storageReference,
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
  const mac = canonicalMacFromNormalizedIdentity(parsed.payload.normalizedDeviceIdentity);
  const deviceMacIdentityTag = mac ? deviceMacTag(identityHmacKey, workspaceDecision.workspace.id, mac) : undefined;
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
    ...(deviceMacIdentityTag ? { deviceMacTag: deviceMacIdentityTag } : {}),
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
  return { ok: true, binding: publicDeviceInventoryBinding(binding) };
}

export function listDeviceInventoryBindings(
  state: RoadexState,
  user: UserProfile,
  projectId: string,
): DeviceInventoryBindingPublic[] | undefined {
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
  return [...state.deviceInventoryBindings.values()]
    .filter((binding) => binding.projectId === workspaceDecision.workspace.id && binding.lifecycle === 'active')
    .map(publicDeviceInventoryBinding);
}

function publicDeviceInventoryBinding(binding: DeviceInventoryBindingRecord): DeviceInventoryBindingPublic {
  const publicBinding = { ...binding };
  delete publicBinding.deviceMacTag;
  return publicBinding;
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

function denyDeviceBridgeApproval(
  state: RoadexState,
  user: UserProfile,
  requestId: string,
  gate: DeviceBridgeApprovalGate,
  auditHmacKey: string,
): DeviceBridgeApprovalResponse {
  const auditEvent = createBridgeAuditEvent(
    state,
    auditHmacKey,
    user,
    'security.denied',
    requestId,
    'denied',
    bridgeAuditSummary(auditHmacKey, {
      classification: gate,
      userId: user.id,
      sessionId: requestId,
    }),
  );
  persistStateSnapshot(state, {
    auditEvents: [...state.audit.events, auditEvent],
  });
  state.audit.events.push(auditEvent);
  return publicDeviceBridgeApprovalDenial(gate);
}

function publicDeviceBridgeApprovalDenial(classification: DeviceBridgeApprovalGate): DeviceBridgeApprovalResponse {
  return {
    ok: false,
    gate: 'device-bridge',
    reason: 'Device bridge approval denied.',
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

function publicDeviceBridgeApproval(approval: DeviceBridgeApprovalRecord): DeviceBridgeApprovalPublic {
  return {
    id: approval.id,
    requestId: approval.requestId,
    sessionId: approval.sessionId,
    projectId: approval.projectId,
    artifactId: approval.artifactId,
    artifactSha256: approval.artifactSha256,
    inventoryBindingId: approval.inventoryBindingId,
    operation: approval.operation,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

function publicDeviceBridgeOperation(operation: DeviceBridgeOperationRecord): DeviceBridgeOperationPublic {
  return {
    id: operation.id,
    approvalId: operation.approvalId,
    sessionId: operation.sessionId,
    projectId: operation.projectId,
    artifactId: operation.artifactId,
    artifactSha256: operation.artifactSha256,
    inventoryBindingId: operation.inventoryBindingId,
    operation: operation.operation,
    phase: operation.phase,
    verifiedArtifactSha256: operation.verifiedArtifactSha256,
    nextEventSequence: operation.nextEventSequence,
    phaseExpiresAt: operation.phaseExpiresAt,
    reportingExpiresAt: operation.reportingExpiresAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function denyDeviceBridgeProbe(
  state: RoadexState,
  user: UserProfile,
  resource: string,
  classification: string,
  auditHmacKey: string,
): Extract<DeviceBridgeProbeResponse, { ok: false }> {
  const auditEvent = createBridgeAuditEvent(
    state, auditHmacKey, user, 'security.denied', resource, 'denied',
    bridgeAuditSummary(auditHmacKey, { classification, userId: user.id, sessionId: resource }),
  );
  persistStateSnapshot(state, { auditEvents: [...state.audit.events, auditEvent] });
  state.audit.events.push(auditEvent);
  return publicDeviceBridgeProbeDenial(classification);
}

function publicDeviceBridgeProbeDenial(classification: string): Extract<DeviceBridgeProbeResponse, { ok: false }> {
  return {
    ok: false,
    gate: 'device-bridge',
    reason: 'Device bridge probe denied.',
    classification,
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

function denyDescriptorObservation(
  state: RoadexState,
  user: UserProfile,
  resource: string,
  gate: DeviceDescriptorObservationGate,
  auditHmacKey: string | undefined,
): DeviceDescriptorObservationResponse {
  if (auditHmacKey) {
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
    persistStateSnapshot(state, { auditEvents: [...state.audit.events, auditEvent] });
    state.audit.events.push(auditEvent);
  }
  return {
    ok: false,
    gate: 'device-bridge',
    reason: 'USB descriptor observation denied.',
    classification: gate,
  };
}

function publicDescriptorObservation(
  observation: DeviceDescriptorObservationRecord,
): DeviceDescriptorObservationPublic {
  return {
    id: observation.id,
    sessionId: observation.sessionId,
    projectId: observation.projectId,
    inventoryBindingId: observation.inventoryBindingId,
    vendorId: observation.vendorId,
    productId: observation.productId,
    status: observation.status,
    verification: observation.verification,
    createdAt: observation.createdAt,
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

function deviceMacTag(key: string, projectId: string, mac: string): string {
  return applicationHmacTag(key, `roadex-device-mac:v1:${projectId}:${canonicalDeviceMac(mac)}`);
}

function canonicalDeviceMac(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, ':');
}

function canonicalMacFromNormalizedIdentity(value: string): string | undefined {
  return value.match(/(?:^|\s)mac\s*=\s*([a-f0-9]{2}(?::[a-f0-9]{2}){5})(?:\s|$)/i)?.[1]?.toLowerCase();
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

function parseDescriptorObservationPayload(payload: unknown): {
  ok: true;
  payload: DeviceDescriptorObservationPayload;
} | {
  ok: false;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = record.serialNumber === undefined
    ? record.deviceMac === undefined
      ? ['inventoryBindingId', 'productId', 'vendorId']
      : ['deviceMac', 'inventoryBindingId', 'productId', 'vendorId']
    : record.deviceMac === undefined
      ? ['inventoryBindingId', 'productId', 'serialNumber', 'vendorId']
      : ['deviceMac', 'inventoryBindingId', 'productId', 'serialNumber', 'vendorId'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false };
  }
  if (
    !boundedToken(record.inventoryBindingId, 128) ||
    !validUsbIdentifier(record.vendorId) ||
    !validUsbIdentifier(record.productId) ||
    (record.serialNumber !== undefined && !validUsbSerial(record.serialNumber)) ||
    (record.deviceMac !== undefined && !validDeviceMac(record.deviceMac))
  ) return { ok: false };
  return {
    ok: true,
    payload: {
      inventoryBindingId: record.inventoryBindingId.trim(),
      vendorId: record.vendorId,
      productId: record.productId,
      ...(record.serialNumber === undefined ? {} : { serialNumber: record.serialNumber.normalize('NFC').trim() }),
      ...(record.deviceMac === undefined ? {} : { deviceMac: canonicalDeviceMac(record.deviceMac) }),
    },
  };
}

function parseDeviceBridgeProbePayload(payload: unknown): DeviceBridgeProbePayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'artifactSha256,deviceMac') return undefined;
  if (
    !validDeviceMac(record.deviceMac) ||
    typeof record.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.artifactSha256)
  ) return undefined;
  return {
    deviceMac: canonicalDeviceMac(record.deviceMac),
    artifactSha256: record.artifactSha256.toLowerCase(),
  };
}

function parseArtifactDigestPayload(payload: unknown): { artifactSha256: string } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).join(',') !== 'artifactSha256') return undefined;
  if (typeof record.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.artifactSha256)) return undefined;
  return { artifactSha256: record.artifactSha256.toLowerCase() };
}

function parseWriteAuthorizationPayload(payload: unknown): { artifactSha256: string; deviceMac: string; writeToken: string } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'artifactSha256,deviceMac,writeToken') return undefined;
  const digest = parseArtifactDigestPayload({ artifactSha256: record.artifactSha256 });
  if (!digest || !validDeviceMac(record.deviceMac) || typeof record.writeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.writeToken)) return undefined;
  return { ...digest, deviceMac: canonicalDeviceMac(record.deviceMac), writeToken: record.writeToken };
}

function parseWriteReportPayload(payload: unknown): { artifactSha256: string; outcome: 'completed' | 'failed'; writeToken: string } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'artifactSha256,outcome,writeToken') return undefined;
  const digest = parseArtifactDigestPayload({ artifactSha256: record.artifactSha256 });
  if (!digest || (record.outcome !== 'completed' && record.outcome !== 'failed') || typeof record.writeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.writeToken)) return undefined;
  return { ...digest, outcome: record.outcome, writeToken: record.writeToken };
}


function validUsbIdentifier(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff;
}

function validUsbSerial(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 128 && !/[\r\n\0]/.test(value);
}

function validDeviceMac(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{2}(?::[a-f0-9]{2}){5}$/i.test(value.trim().replace(/-/g, ':'));
}

function usbProfileAllowsOperation(state: RoadexState, projectId: string, operation: UsbDeviceOperation): boolean {
  return state.usbDeviceProfiles.some((profile) =>
    profile.workspaceId === projectId && profile.operations.includes(operation));
}

function usbProfileAllowsDescriptor(
  state: RoadexState,
  projectId: string,
  operation: UsbDeviceOperation,
  vendorId: number,
  productId: number,
): boolean {
  return state.usbDeviceProfiles.some((profile) =>
    profile.workspaceId === projectId && profile.operations.includes(operation) &&
    profile.filters.some((filter) => filter.vendorId === vendorId && filter.productId === productId));
}

function readProjectArtifactMetadata(
  workspaceRoot: string,
  payload: DeviceArtifactMetadataRegistrationPayload,
): {
  ok: true;
  metadata: Pick<DeviceArtifactMetadata, 'label' | 'byteLength' | 'sha256'>;
  bytes: Buffer;
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
    if (!before.isFile() || before.size <= 0 || before.size > maxDeviceArtifactBytes) return { ok: false };
    const descriptorPath = realpathSync(`/proc/self/fd/${fd}`);
    if (!isPathWithin(root, descriptorPath)) return { ok: false };
    if (extname(descriptorPath).toLowerCase() !== '.bin') return { ok: false };
    const hashed = hashOpenFileDescriptor(fd, before.size);
    if (!hashed.ok) return { ok: false };
    const bytes = readFileSync(fd);
    if (bytes.byteLength !== before.size || createHash('sha256').update(bytes).digest('hex') !== hashed.sha256) return { ok: false };
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
      bytes,
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
    if (offset > maxDeviceArtifactBytes) return { ok: false };
  }
  if (offset <= 0 || offset !== expectedSize || offset > maxDeviceArtifactBytes) return { ok: false };
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

function expiredIso(value: string): boolean {
  return Date.parse(value) <= Date.now();
}

function saveState(state: RoadexState): void {
  state.persistence.save(serializeState({
    sessions: state.sessions.sessions,
    streamEvents: state.sessions.streamEvents,
    auditEvents: state.audit.events,
    managedThreadClaims: [...state.managedThreadClaims.values()],
    approvalWaits: state.approvalWaits,
    deviceArtifacts: [...state.deviceArtifacts.values()],
    deviceBridgeRequests: [...state.deviceBridgeRequests.values()],
    deviceBridgeApprovals: [...state.deviceBridgeApprovals.values()],
    deviceBridgeOperations: [...state.deviceBridgeOperations.values()],
    deviceInventoryBindings: [...state.deviceInventoryBindings.values()],
    deviceDescriptorObservations: [...state.deviceDescriptorObservations.values()],
  }));
}

function pseudonymizeControlledOperationResource(sessionId: string): string {
  const key = process.env.ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY;
  if (!key || Buffer.byteLength(key) < 32) return 'controlled-operation-unavailable';
  return `controlled-operation-${createHmac('sha256', key).update(sessionId).digest('hex').slice(0, 24)}`;
}

function persistStateSnapshot(
  state: RoadexState,
  overrides: Partial<{
    sessions: RoadexSession[];
    streamEvents: StreamEvent[];
    auditEvents: AuditEvent[];
    managedThreadClaims: ManagedThreadClaim[];
    approvalWaits: ApprovalWaitRecord[];
    deviceArtifacts: DeviceArtifactMetadata[];
    deviceBridgeRequests: DeviceBridgeRequestRecord[];
    deviceBridgeApprovals: DeviceBridgeApprovalRecord[];
    deviceBridgeOperations: DeviceBridgeOperationRecord[];
    deviceInventoryBindings: DeviceInventoryBindingRecord[];
    deviceDescriptorObservations: DeviceDescriptorObservationRecord[];
  }>,
): void {
  state.persistence.save(serializeState({
    sessions: overrides.sessions ?? state.sessions.sessions,
    streamEvents: overrides.streamEvents ?? state.sessions.streamEvents,
    auditEvents: overrides.auditEvents ?? state.audit.events,
    managedThreadClaims: overrides.managedThreadClaims ?? [...state.managedThreadClaims.values()],
    approvalWaits: overrides.approvalWaits ?? state.approvalWaits,
    deviceArtifacts: overrides.deviceArtifacts ?? [...state.deviceArtifacts.values()],
    deviceBridgeRequests: overrides.deviceBridgeRequests ?? [...state.deviceBridgeRequests.values()],
    deviceBridgeApprovals: overrides.deviceBridgeApprovals ?? [...state.deviceBridgeApprovals.values()],
    deviceBridgeOperations: overrides.deviceBridgeOperations ?? [...state.deviceBridgeOperations.values()],
    deviceInventoryBindings: overrides.deviceInventoryBindings ?? [...state.deviceInventoryBindings.values()],
    deviceDescriptorObservations: overrides.deviceDescriptorObservations ?? [...state.deviceDescriptorObservations.values()],
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
