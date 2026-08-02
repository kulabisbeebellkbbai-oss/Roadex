import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, ManagedThreadClaim, RoadexSession, StreamEvent } from '../shared/sessionContracts.js';
import {
  type ApprovalAuthorityClass,
  type ApprovalConsoleSurface,
  type ApprovalWaitRecord,
  isActiveApprovalWait,
  type ApprovalWaitState,
  consoleForAuthority,
} from '../shared/approvalWorkflowContracts.js';
import type {
  DeviceArtifactMetadata,
  DeviceBridgeApprovalRecord,
  DeviceBridgeOperationRecord,
  DeviceBridgeRequestRecord,
  DeviceDescriptorObservationRecord,
  DeviceInventoryBindingRecord,
} from '../shared/deviceBridgeContracts.js';

export type PersistedRoadexState = {
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
};

export type StatePersistence = {
  load: () => PersistedRoadexState;
  save: (state: PersistedRoadexState) => void;
};

export type RetentionOptions = {
  now?: number;
  maxSessions?: number;
  maxStreamEvents?: number;
  maxAuditEvents?: number;
  sessionRetentionMs?: number;
  maxDeviceArtifacts?: number;
  maxDeviceRequests?: number;
  maxDeviceApprovals?: number;
  maxDeviceOperations?: number;
  deviceBridgeRetentionMs?: number;
  maxApprovalWaits?: number;
  approvalWaitRetentionMs?: number;
};

export function createMemoryPersistence(initial?: Partial<PersistedRoadexState>): StatePersistence {
  let state: PersistedRoadexState = {
    sessions: initial?.sessions ?? [],
    streamEvents: initial?.streamEvents ?? [],
    auditEvents: initial?.auditEvents ?? [],
    managedThreadClaims: initial?.managedThreadClaims ?? [],
    approvalWaits: initial?.approvalWaits ?? [],
    deviceArtifacts: initial?.deviceArtifacts ?? [],
    deviceBridgeRequests: initial?.deviceBridgeRequests ?? [],
    deviceBridgeApprovals: initial?.deviceBridgeApprovals ?? [],
    deviceBridgeOperations: initial?.deviceBridgeOperations ?? [],
    deviceInventoryBindings: initial?.deviceInventoryBindings ?? [],
    deviceDescriptorObservations: initial?.deviceDescriptorObservations ?? [],
  };
  return {
    load() {
      return cloneState(state);
    },
    save(next) {
      state = cloneState(next);
    },
  };
}

export function createJsonFilePersistence(
  path = process.env.ROADEX_STATE_PATH ?? 'data/roadex-state.json',
): StatePersistence {
  return {
    load() {
      try {
        return serializeState(JSON.parse(readFileSync(path, 'utf8')) as PersistedRoadexState);
      } catch {
        return emptyState();
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(serializeState(state), null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export function serializeState(state: Partial<PersistedRoadexState>, options: RetentionOptions = {}): PersistedRoadexState {
  return applyRetention(sanitizeState(state, options.now), options);
}

function sanitizeState(state: Partial<PersistedRoadexState>, now = Date.now()): PersistedRoadexState {
  const timestamp = new Date(now).toISOString();
  const legacyTimeoutSessions = legacyTimeoutBlockedSessionIds(state.streamEvents ?? []);
  return {
    sessions: (state.sessions ?? []).map((session) => ({
      ...session,
      lifecycle: session.lifecycle === 'streaming'
        || session.lifecycle === 'pending'
        || (session.lifecycle === 'blocked' && legacyTimeoutSessions.has(session.id))
        ? 'ready'
        : session.lifecycle,
      runActivity: undefined,
      deviceBridge: 'disabled',
      createdAt: session.createdAt ?? timestamp,
      updatedAt: session.updatedAt ?? session.createdAt ?? timestamp,
      codexThreadId: cleanOptionalString(session.codexThreadId),
      managedThreadId: cleanOptionalString(session.managedThreadId),
    })),
    approvalWaits: (state.approvalWaits ?? []).flatMap((record) => sanitizeApprovalWait(record) ?? []),
    streamEvents: state.streamEvents ?? [],
    auditEvents: state.auditEvents ?? [],
    managedThreadClaims: (state.managedThreadClaims ?? []).filter(
      (claim) => Boolean(cleanOptionalString(claim.threadId) && cleanOptionalString(claim.userId)),
    ),
    deviceArtifacts: (state.deviceArtifacts ?? []).flatMap((record) => sanitizeArtifact(record) ?? []),
    deviceBridgeRequests: (state.deviceBridgeRequests ?? []).flatMap((record) => sanitizeRequest(record) ?? []),
    deviceBridgeApprovals: (state.deviceBridgeApprovals ?? []).flatMap((record) => sanitizeApproval(record) ?? []),
    deviceBridgeOperations: (state.deviceBridgeOperations ?? []).flatMap((record) => sanitizeOperation(record) ?? []),
    deviceInventoryBindings: (state.deviceInventoryBindings ?? []).flatMap((record) => sanitizeInventoryBinding(record) ?? []),
    deviceDescriptorObservations: (state.deviceDescriptorObservations ?? []).flatMap((record) => sanitizeDescriptorObservation(record) ?? []),
  };
}

function legacyTimeoutBlockedSessionIds(events: StreamEvent[]): Set<string> {
  const terminalBySession = new Map<string, string[]>();
  for (const event of events) {
    if (
      event.kind !== 'system'
      || ![
        'Codex runner completed.',
        'Codex runner was cancelled.',
        'Codex runner timed out and was stopped.',
        'Codex runner failed.',
      ].includes(event.message)
    ) continue;
    const terminal = terminalBySession.get(event.sessionId) ?? [];
    terminal.push(event.message);
    terminalBySession.set(event.sessionId, terminal.slice(-2));
  }
  return new Set(
    [...terminalBySession.entries()]
      .filter(([, terminal]) => (
        terminal[0] === 'Codex runner timed out and was stopped.'
        && terminal[1] === 'Codex runner failed.'
      ))
      .map(([sessionId]) => sessionId),
  );
}

function applyRetention(state: PersistedRoadexState, options: RetentionOptions): PersistedRoadexState {
  const now = options.now ?? Date.now();
  const maxSessions = options.maxSessions ?? numberFromEnv('ROADEX_STATE_MAX_SESSIONS', 50);
  const maxStreamEvents = options.maxStreamEvents ?? numberFromEnv('ROADEX_STATE_MAX_STREAM_EVENTS', 500);
  const maxAuditEvents = options.maxAuditEvents ?? numberFromEnv('ROADEX_STATE_MAX_AUDIT_EVENTS', 500);
  const sessionRetentionMs = options.sessionRetentionMs ?? numberFromEnv('ROADEX_SESSION_RETENTION_MS', 2_592_000_000);
  const deviceBridgeRetentionMs = options.deviceBridgeRetentionMs ?? numberFromEnv('ROADEX_DEVICE_BRIDGE_RETENTION_MS', 2_592_000_000);
  const maxApprovalWaits = options.maxApprovalWaits ?? numberFromEnv('ROADEX_MAX_APPROVAL_WAITS', 500);
  const approvalWaitRetentionMs = options.approvalWaitRetentionMs ?? numberFromEnv(
    'ROADEX_APPROVAL_WAIT_RETENTION_MS',
    2_592_000_000,
  );
  const maxDeviceArtifacts = options.maxDeviceArtifacts ?? numberFromEnv('ROADEX_MAX_DEVICE_ARTIFACTS', 100);
  const maxDeviceRequests = options.maxDeviceRequests ?? numberFromEnv('ROADEX_MAX_DEVICE_REQUESTS', 200);
  const maxDeviceApprovals = options.maxDeviceApprovals ?? numberFromEnv('ROADEX_MAX_DEVICE_APPROVALS', 200);
  const maxDeviceOperations = options.maxDeviceOperations ?? numberFromEnv('ROADEX_MAX_DEVICE_OPERATIONS', 200);
  const cutoff = now - sessionRetentionMs;
  const deviceCutoff = now - deviceBridgeRetentionMs;
  const approvalCutoff = now - approvalWaitRetentionMs;
  const retainedSessionIds = new Set(
    state.sessions
      .filter((session) => {
        if (session.lifecycle === 'ready' || session.lifecycle === 'streaming' || session.lifecycle === 'paused') {
          return true;
        }
        return sessionTimestamp(session) >= cutoff;
      })
      .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left))
      .slice(0, maxSessions)
      .map((session) => session.id),
  );

  const deviceBridgeRequests = retainByTimestamp(
    state.deviceBridgeRequests,
    (record) => record.createdAt,
    deviceCutoff,
    maxDeviceRequests,
  );
  const deviceBridgeApprovals = retainByTimestamp(
    state.deviceBridgeApprovals,
    (record) => record.createdAt,
    deviceCutoff,
    maxDeviceApprovals,
  );
  const deviceBridgeOperations = retainByTimestamp(
    state.deviceBridgeOperations,
    (record) => record.updatedAt,
    deviceCutoff,
    maxDeviceOperations,
  );
  const referencedArtifactIds = new Set([
    ...deviceBridgeRequests.map((record) => record.artifactId),
    ...deviceBridgeApprovals.map((record) => record.artifactId),
    ...deviceBridgeOperations.map((record) => record.artifactId),
  ]);
  const referencedArtifacts = state.deviceArtifacts.filter((record) => referencedArtifactIds.has(record.id));
  const unreferencedArtifactSlots = Math.max(0, maxDeviceArtifacts - referencedArtifacts.length);
  const unreferencedArtifacts = state.deviceArtifacts
    .filter((record) => !referencedArtifactIds.has(record.id) && Date.parse(record.createdAt) >= deviceCutoff)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, unreferencedArtifactSlots);
  const deviceArtifacts = [...referencedArtifacts, ...unreferencedArtifacts];
  const activeApprovalWaits = state.approvalWaits.filter((record) => isActiveApprovalWait(record.state));
  const activeById = new Map(activeApprovalWaits.map((record) => [record.id, record]));
  const terminalWaitLimit = Math.max(0, maxApprovalWaits - activeById.size);
  const terminalApprovalWaits = state.approvalWaits
    .filter((record) => !isActiveApprovalWait(record.state))
    .filter((record) => approvalWaitTimestamp(record) >= approvalCutoff)
    .sort((left, right) => approvalWaitTimestamp(right) - approvalWaitTimestamp(left))
    .slice(0, terminalWaitLimit);
  const approvalWaits = [
    ...activeById.values(),
    ...terminalApprovalWaits,
  ];

  return {
    sessions: state.sessions.filter((session) => retainedSessionIds.has(session.id)),
    streamEvents: state.streamEvents
      .filter((event) => retainedSessionIds.has(event.sessionId))
      .slice(-maxStreamEvents),
    auditEvents: state.auditEvents.slice(-maxAuditEvents),
    managedThreadClaims: state.managedThreadClaims,
    approvalWaits,
    deviceArtifacts,
    deviceBridgeRequests,
    deviceBridgeApprovals,
    deviceBridgeOperations,
    deviceInventoryBindings: state.deviceInventoryBindings,
    deviceDescriptorObservations: retainByTimestamp(
      state.deviceDescriptorObservations,
      (record) => record.createdAt,
      deviceCutoff,
      maxDeviceRequests,
    ),
  };
}

function sessionTimestamp(session: RoadexSession): number {
  const parsed = Date.parse(session.updatedAt || session.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function emptyState(): PersistedRoadexState {
  return {
    sessions: [],
    streamEvents: [],
    auditEvents: [],
    managedThreadClaims: [],
    approvalWaits: [],
    deviceArtifacts: [],
    deviceBridgeRequests: [],
    deviceBridgeApprovals: [],
    deviceBridgeOperations: [],
    deviceInventoryBindings: [],
    deviceDescriptorObservations: [],
  };
}

function sanitizeDescriptorObservation(record: DeviceDescriptorObservationRecord): DeviceDescriptorObservationRecord | undefined {
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.userId, 128) &&
    validBoundedString(record.sessionId, 128) &&
    validBoundedString(record.projectId, 128) &&
    validBoundedString(record.inventoryBindingId, 128) &&
    Number.isInteger(record.vendorId) && record.vendorId >= 0 && record.vendorId <= 65535 &&
    Number.isInteger(record.productId) && record.productId >= 0 && record.productId <= 65535 &&
    /^[a-f0-9]{64}$/i.test(record.descriptorFingerprint) &&
    record.status === 'observed' &&
    ['unverified', 'verified', 'mismatch'].includes(record.verification) &&
    validIsoDate(record.createdAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    userId: record.userId.trim(),
    sessionId: record.sessionId.trim(),
    projectId: record.projectId.trim(),
    inventoryBindingId: record.inventoryBindingId.trim(),
    vendorId: record.vendorId,
    productId: record.productId,
    descriptorFingerprint: record.descriptorFingerprint.toLowerCase(),
    status: 'observed',
    verification: record.verification,
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

function sanitizeArtifact(record: DeviceArtifactMetadata): DeviceArtifactMetadata | undefined {
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.projectId, 128) &&
    validBoundedString(record.sessionId, 128) &&
    validBoundedString(record.producerUserId, 128) &&
    validOptionalBoundedString(record.producerThreadId, 128) &&
    validOptionalBoundedString(record.producerRunId, 128) &&
    /^[a-zA-Z0-9._-]{1,128}$/.test(record.label) &&
    Number.isSafeInteger(record.byteLength) &&
    record.byteLength > 0 &&
    record.byteLength <= 16 * 1024 * 1024 &&
    record.mediaType === 'application/octet-stream' &&
    record.format === 'esp32-firmware-bin' &&
    /^[a-f0-9]{64}$/i.test(record.sha256) &&
    validBoundedString(record.storageReference, 160) &&
    !record.storageReference.includes('/') &&
    ['active', 'revoked', 'expired'].includes(record.status) &&
    validIsoDate(record.createdAt) &&
    validIsoDate(record.expiresAt) &&
    validOptionalIsoDate(record.revokedAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    projectId: record.projectId.trim(),
    sessionId: record.sessionId.trim(),
    producerUserId: record.producerUserId.trim(),
    producerThreadId: cleanOptionalString(record.producerThreadId),
    producerRunId: cleanOptionalString(record.producerRunId),
    label: record.label.trim(),
    byteLength: record.byteLength,
    mediaType: 'application/octet-stream',
    format: 'esp32-firmware-bin',
    sha256: record.sha256.toLowerCase(),
    storageReference: record.storageReference.trim(),
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    revokedAt: cleanOptionalIsoDate(record.revokedAt),
  };
}

function sanitizeInventoryBinding(record: DeviceInventoryBindingRecord): DeviceInventoryBindingRecord | undefined {
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.projectId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.deviceIdentityTag) &&
    (record.deviceMacTag === undefined || /^[a-f0-9]{64}$/i.test(record.deviceMacTag)) &&
    record.allowedOperation === 'esp32.flash' &&
    ['required', 'not-required', 'unknown'].includes(record.secureBootExpected) &&
    ['required', 'not-required', 'unknown'].includes(record.flashEncryptionExpected) &&
    ['active', 'revoked'].includes(record.lifecycle) &&
    validBoundedString(record.createdBy, 128) &&
    validIsoDate(record.createdAt) &&
    validOptionalIsoDate(record.revokedAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    projectId: record.projectId.trim(),
    deviceIdentityTag: record.deviceIdentityTag.toLowerCase(),
    ...(record.deviceMacTag ? { deviceMacTag: record.deviceMacTag.toLowerCase() } : {}),
    allowedOperation: 'esp32.flash',
    secureBootExpected: record.secureBootExpected,
    flashEncryptionExpected: record.flashEncryptionExpected,
    lifecycle: record.lifecycle,
    createdBy: record.createdBy.trim(),
    createdAt: new Date(record.createdAt).toISOString(),
    revokedAt: cleanOptionalIsoDate(record.revokedAt),
  };
}

function sanitizeRequest(record: DeviceBridgeRequestRecord): DeviceBridgeRequestRecord | undefined {
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.userId, 128) &&
    validBoundedString(record.sessionId, 128) &&
    validBoundedString(record.projectId, 128) &&
    validBoundedString(record.artifactId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.artifactSha256) &&
    validBoundedString(record.inventoryBindingId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.deviceIdentityTag) &&
    record.operation === 'esp32.flash' &&
    ['pending', 'approved', 'revoked', 'expired'].includes(record.status) &&
    validIsoDate(record.createdAt) &&
    validIsoDate(record.expiresAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    userId: record.userId.trim(),
    sessionId: record.sessionId.trim(),
    projectId: record.projectId.trim(),
    artifactId: record.artifactId.trim(),
    artifactSha256: record.artifactSha256.toLowerCase(),
    inventoryBindingId: record.inventoryBindingId.trim(),
    deviceIdentityTag: record.deviceIdentityTag.toLowerCase(),
    operation: 'esp32.flash',
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

function sanitizeApproval(record: DeviceBridgeApprovalRecord): DeviceBridgeApprovalRecord | undefined {
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.requestId, 128) &&
    validBoundedString(record.userId, 128) &&
    validBoundedString(record.sessionId, 128) &&
    validBoundedString(record.projectId, 128) &&
    validBoundedString(record.artifactId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.artifactSha256) &&
    validBoundedString(record.inventoryBindingId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.deviceIdentityTag) &&
    /^[a-f0-9]{64}$/i.test(record.credentialDigest) &&
    record.operation === 'esp32.flash' &&
    ['pending', 'consumed', 'revoked', 'expired'].includes(record.status) &&
    validIsoDate(record.createdAt) &&
    validIsoDate(record.expiresAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    requestId: record.requestId.trim(),
    userId: record.userId.trim(),
    sessionId: record.sessionId.trim(),
    projectId: record.projectId.trim(),
    artifactId: record.artifactId.trim(),
    artifactSha256: record.artifactSha256.toLowerCase(),
    inventoryBindingId: record.inventoryBindingId.trim(),
    deviceIdentityTag: record.deviceIdentityTag.toLowerCase(),
    credentialDigest: record.credentialDigest.toLowerCase(),
    operation: 'esp32.flash',
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

function sanitizeOperation(record: DeviceBridgeOperationRecord): DeviceBridgeOperationRecord | undefined {
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.approvalId, 128) &&
    validBoundedString(record.userId, 128) &&
    validBoundedString(record.sessionId, 128) &&
    validBoundedString(record.projectId, 128) &&
    validBoundedString(record.artifactId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.artifactSha256) &&
    validBoundedString(record.inventoryBindingId, 128) &&
    /^[a-f0-9]{64}$/i.test(record.deviceIdentityTag) &&
    record.operation === 'esp32.flash' &&
    ['probe', 'verified', 'confirmation', 'destructive', 'reporting', 'completed', 'failed', 'cancelled'].includes(record.phase) &&
    /^[a-f0-9]{64}$/i.test(record.credentialDigest) &&
    (!record.actualDeviceIdentityTag || /^[a-f0-9]{64}$/i.test(record.actualDeviceIdentityTag)) &&
    (!record.verifiedArtifactSha256 || /^[a-f0-9]{64}$/i.test(record.verifiedArtifactSha256)) &&
    (!record.confirmationChallengeDigest || /^[a-f0-9]{64}$/i.test(record.confirmationChallengeDigest)) &&
    (!record.destructiveNonceDigest || /^[a-f0-9]{64}$/i.test(record.destructiveNonceDigest)) &&
    Number.isSafeInteger(record.nextEventSequence) &&
    record.nextEventSequence >= 0 &&
    validIsoDate(record.phaseExpiresAt) &&
    validIsoDate(record.reportingExpiresAt) &&
    validIsoDate(record.createdAt) &&
    validIsoDate(record.updatedAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    approvalId: record.approvalId.trim(),
    userId: record.userId.trim(),
    sessionId: record.sessionId.trim(),
    projectId: record.projectId.trim(),
    artifactId: record.artifactId.trim(),
    artifactSha256: record.artifactSha256.toLowerCase(),
    inventoryBindingId: record.inventoryBindingId.trim(),
    deviceIdentityTag: record.deviceIdentityTag.toLowerCase(),
    operation: 'esp32.flash',
    phase: record.phase,
    credentialDigest: record.credentialDigest.toLowerCase(),
    ...(record.actualDeviceIdentityTag ? { actualDeviceIdentityTag: record.actualDeviceIdentityTag.toLowerCase() } : {}),
    ...(record.verifiedArtifactSha256
      ? { verifiedArtifactSha256: record.verifiedArtifactSha256.toLowerCase() }
      : {}),
    ...(record.confirmationChallengeDigest
      ? { confirmationChallengeDigest: record.confirmationChallengeDigest.toLowerCase() }
      : {}),
    ...(record.destructiveNonceDigest
      ? { destructiveNonceDigest: record.destructiveNonceDigest.toLowerCase() }
      : {}),
    nextEventSequence: record.nextEventSequence,
    phaseExpiresAt: new Date(record.phaseExpiresAt).toISOString(),
    reportingExpiresAt: new Date(record.reportingExpiresAt).toISOString(),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

function sanitizeApprovalWait(record: ApprovalWaitRecord): ApprovalWaitRecord | undefined {
  const sanitizedPath = sanitizeApprovalWaitConsolePath(cleanOptionalString(record.consolePath));
  if (!(
    validBoundedString(record.id, 128) &&
    validBoundedString(record.sessionId, 128) &&
    validBoundedString(record.userId, 128) &&
    validBoundedString(record.projectId, 128) &&
    validBoundedString(record.workspaceId, 128) &&
    validBoundedString(record.managedThreadId, 128) &&
    record.provider === 'overseer' &&
    validBoundedString(record.approvalRef, 256) &&
    validBoundedString(record.resourceRef, 256) &&
    isApprovalAuthorityClass(record.authorityClass) &&
    record.consoleSurface === consoleForAuthority(record.authorityClass) &&
    (record.consolePath === undefined || sanitizedPath !== undefined) &&
    validBoundedString(record.subject, 256) &&
    isApprovalWaitState(record.state) &&
    validBoundedString(record.decisionVersion, 128) &&
    validBoundedString(record.continuationId, 256) &&
    Number.isSafeInteger(record.checkAttempt) &&
    record.checkAttempt >= 0 &&
    validIsoDate(record.nextCheckAt) &&
    validIsoDate(record.createdAt) &&
    validIsoDate(record.updatedAt) &&
    validOptionalIsoDate(record.decisionObservedAt) &&
    validOptionalIsoDate(record.dispatchReservedAt) &&
    validOptionalBoundedString(record.runnerRunId, 256) &&
    validOptionalIsoDate(record.resumedAt)
  )) return undefined;
  return {
    id: record.id.trim(),
    sessionId: record.sessionId.trim(),
    userId: record.userId.trim(),
    projectId: record.projectId.trim(),
    workspaceId: record.workspaceId.trim(),
    managedThreadId: record.managedThreadId.trim(),
    provider: 'overseer',
    approvalRef: record.approvalRef.trim(),
    resourceRef: record.resourceRef.trim(),
    authorityClass: record.authorityClass,
    consoleSurface: consoleForAuthority(record.authorityClass),
    ...(sanitizedPath ? { consolePath: sanitizedPath } : {}),
    subject: record.subject.trim(),
    state: record.state,
    decisionVersion: record.decisionVersion.trim(),
    continuationId: record.continuationId.trim(),
    checkAttempt: record.checkAttempt,
    nextCheckAt: new Date(record.nextCheckAt).toISOString(),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.decisionObservedAt ? { decisionObservedAt: new Date(record.decisionObservedAt).toISOString() } : {}),
    ...(record.dispatchReservedAt ? { dispatchReservedAt: new Date(record.dispatchReservedAt).toISOString() } : {}),
    ...(record.runnerRunId ? { runnerRunId: record.runnerRunId.trim() } : {}),
    ...(record.resumedAt ? { resumedAt: new Date(record.resumedAt).toISOString() } : {}),
  };
}

const APPROVAL_CONSOLE_PATH_ALLOWLIST: Record<ApprovalConsoleSurface, string[]> = {
  admin: ['admin/approvals'],
  overview: ['overview/approvals'],
};

const APPROVAL_WAIT_STATES: ApprovalWaitState[] = [
  'pending',
  'verification-delayed',
  'security-failure',
  'changes-requested',
  'rejected',
  'expired',
  'revoked',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
  'resumed',
  'session-closed',
];

const APPROVAL_AUTHORITY_CLASSES: ApprovalAuthorityClass[] = ['privileged-operation', 'project-workflow'];

function isApprovalAuthorityClass(value: string): value is ApprovalAuthorityClass {
  return APPROVAL_AUTHORITY_CLASSES.includes(value as ApprovalAuthorityClass);
}

function isApprovalWaitState(value: string): value is ApprovalWaitState {
  return APPROVAL_WAIT_STATES.includes(value as ApprovalWaitState);
}

function sanitizeApprovalWaitConsolePath(consolePath: string | undefined): string | undefined {
  const trimmed = cleanOptionalString(consolePath);
  if (trimmed === undefined) return undefined;
  if (
    !validRelativeConsolePath(trimmed)
    || !isAllowedApprovalWaitConsolePath(trimmed)
  ) return undefined;
  return trimmed;
}

function validRelativeConsolePath(value: string): boolean {
  return !(
    value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || value.includes('..')
    || value.includes('?')
    || value.includes('#')
  );
}

function isAllowedApprovalWaitConsolePath(value: string): boolean {
  const [surface] = value.split('/');
  return APPROVAL_CONSOLE_PATH_ALLOWLIST[surface as ApprovalConsoleSurface] !== undefined
    && APPROVAL_CONSOLE_PATH_ALLOWLIST[surface as ApprovalConsoleSurface].some(
      (allowed) => value === allowed || value.startsWith(`${allowed}/`),
    );
}

function validIsoDate(value: string): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validOptionalIsoDate(value: string | undefined): boolean {
  return value === undefined || validIsoDate(value);
}

function validBoundedString(value: string, maxLength: number): boolean {
  const cleaned = cleanOptionalString(value);
  return Boolean(cleaned && cleaned.length <= maxLength);
}

function validOptionalBoundedString(value: string | undefined, maxLength: number): boolean {
  return value === undefined || validBoundedString(value, maxLength);
}

function cleanOptionalIsoDate(value: string | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function retainByTimestamp<T>(
  records: T[],
  timestamp: (record: T) => string,
  cutoff: number,
  maximum: number,
): T[] {
  return records
    .filter((record) => Date.parse(timestamp(record)) >= cutoff)
    .sort((left, right) => Date.parse(timestamp(right)) - Date.parse(timestamp(left)))
    .slice(0, maximum);
}

function approvalWaitTimestamp(record: ApprovalWaitRecord): number {
  const parsed = Date.parse(record.updatedAt || record.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function cloneState(state: PersistedRoadexState): PersistedRoadexState {
  return JSON.parse(JSON.stringify(state)) as PersistedRoadexState;
}
