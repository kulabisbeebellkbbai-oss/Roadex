import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { AuditEvent, ManagedThreadClaim, RoadexSession, StreamEvent } from '../shared/sessionContracts.js';
import {
  type ApprovalAuthorityClass,
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
  readAuthoritative?: () => AuthoritativeStateRead;
};

export type JsonFilePersistenceOperations = {
  openFile: (path: string, flags: number, mode: number) => number;
  writeFile: (fd: number, contents: string) => void;
  syncFile: (fd: number) => void;
  closeFile: (fd: number) => void;
  rename: (from: string, to: string) => void;
  openDirectory: (path: string) => number;
  syncDirectory: (fd: number) => void;
  closeDirectory: (fd: number) => void;
  unlink: (path: string) => void;
};

class JsonPersistenceDurabilityError extends Error {
  readonly afterRename = true;

  constructor(cause: unknown) {
    super('JSON persistence durability was not established.', { cause });
    this.name = 'JsonPersistenceDurabilityError';
  }
}

const defaultJsonFilePersistenceOperations: JsonFilePersistenceOperations = {
  openFile: (path, flags, mode) => openSync(path, flags, mode),
  writeFile: (fd, contents) => writeFileSync(fd, contents, { encoding: 'utf8' }),
  syncFile: fsyncSync,
  closeFile: closeSync,
  rename: renameSync,
  openDirectory: (path) => openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
  syncDirectory: fsyncSync,
  closeDirectory: closeSync,
  unlink: unlinkSync,
};

const temporaryFileFlags = fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_NOFOLLOW
  | fsConstants.O_WRONLY;
const temporaryFileAttempts = 16;

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}

function temporaryPathFor(path: string, attempt: number): string {
  return `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}-${attempt}`;
}

export type AuthoritativeStateRead =
  | { outcome: 'valid'; state: PersistedRoadexState }
  | { outcome: 'indeterminate' };

export type RegistrationCanonicalTuple = {
  wait: ApprovalWaitRecord;
  session: Pick<RoadexSession, 'id' | 'lifecycle' | 'waitingApproval'>;
  streamEvent: StreamEvent;
  auditEvent: AuditEvent;
};

export type RegistrationCommitOutcome = 'committed' | 'not-committed' | 'indeterminate';

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
    readAuthoritative() {
      return { outcome: 'valid', state: cloneState(state) };
    },
    save(next) {
      state = cloneState(next);
    },
  };
}

export function createJsonFilePersistence(
  path = process.env.ROADEX_STATE_PATH ?? 'data/roadex-state.json',
  operations: JsonFilePersistenceOperations = defaultJsonFilePersistenceOperations,
): StatePersistence {
  return {
    load() {
      try {
        return serializeState(JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedRoadexState>);
      } catch {
        return emptyState();
      }
    },
    readAuthoritative() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const state = parseAuthoritativeState(parsed);
        return state ? { outcome: 'valid', state } : { outcome: 'indeterminate' };
      } catch (error) {
        if (isMissingFile(error)) return { outcome: 'valid', state: emptyState() };
        return { outcome: 'indeterminate' };
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      let tmp: string | undefined;
      let file: number | undefined;
      try {
        for (let attempt = 0; attempt < temporaryFileAttempts; attempt += 1) {
          const candidate = temporaryPathFor(path, attempt);
          try {
            file = operations.openFile(candidate, temporaryFileFlags, 0o600);
            tmp = candidate;
            break;
          } catch (error) {
            if (!isAlreadyExistsError(error) || attempt === temporaryFileAttempts - 1) throw error;
          }
        }
        if (file === undefined || tmp === undefined) throw new Error('Unable to create a temporary JSON state file.');
        operations.writeFile(file, `${JSON.stringify(serializeState(state), null, 2)}\n`);
        operations.syncFile(file);
        operations.closeFile(file);
        file = undefined;
        operations.rename(tmp, path);
        tmp = undefined;
        syncJsonPersistenceDirectory(dirname(path), operations);
      } catch (error) {
        if (file !== undefined) {
          try {
            operations.closeFile(file);
          } catch { /* Preserve the original failure. */ }
        }
        if (tmp !== undefined) {
          try { operations.unlink(tmp); } catch { /* Preserve the original failure. */ }
        }
        throw error;
      }
    },
  };
}

export function commitAuthoritativeRegistration(
  persistence: StatePersistence,
  snapshot: PersistedRoadexState,
  expected: RegistrationCanonicalTuple,
): RegistrationCommitOutcome {
  let saveError: unknown;
  try {
    persistence.save(snapshot);
  } catch (error) {
    saveError = error;
    // The strict read below distinguishes a post-rename exception from a failed write.
  }

  let authoritative: AuthoritativeStateRead | undefined;
  try {
    authoritative = persistence.readAuthoritative?.();
  } catch {
    return 'indeterminate';
  }
  if (!authoritative || authoritative.outcome === 'indeterminate') {
    return 'indeterminate';
  }

  const state = authoritative.state;
  const matchingWaits = state.approvalWaits.filter((record) => record.id === expected.wait.id);
  const matchingSessions = state.sessions.filter((session) => session.id === expected.session.id);
  const matchingStreamEvents = state.streamEvents.filter((event) => event.id === expected.streamEvent.id);
  const matchingAuditEvents = state.auditEvents.filter((event) => event.id === expected.auditEvent.id);
  const componentCounts = [
    matchingWaits.length,
    matchingSessions.length,
    matchingStreamEvents.length,
    matchingAuditEvents.length,
  ];
  if (componentCounts.every((count) => count === 0)) return 'not-committed';
  if (
    matchingWaits.length === 1
    && matchingSessions.length === 1
    && matchingStreamEvents.length === 1
    && matchingAuditEvents.length === 1
    && deepEqual(matchingWaits[0], expected.wait)
    && deepEqual(
      projectRegistrationSession(matchingSessions[0]),
      expected.session,
    )
    && deepEqual(matchingStreamEvents[0], expected.streamEvent)
    && deepEqual(matchingAuditEvents[0], expected.auditEvent)
  ) {
    if (saveError instanceof JsonPersistenceDurabilityError && saveError.afterRename) return 'indeterminate';
    return 'committed';
  }
  return 'indeterminate';
}

function syncJsonPersistenceDirectory(
  directoryPath: string,
  operations: JsonFilePersistenceOperations,
): void {
  let directory: number | undefined;
  let failure: unknown;
  try {
    directory = operations.openDirectory(directoryPath);
    operations.syncDirectory(directory);
  } catch (error) {
    failure = error;
  } finally {
    if (directory !== undefined) {
      try {
        operations.closeDirectory(directory);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw new JsonPersistenceDurabilityError(failure);
}

export function serializeState(state: Partial<PersistedRoadexState>, options: RetentionOptions = {}): PersistedRoadexState {
  return applyRetention(sanitizeState(state, options.now), options);
}

function sanitizeState(state: Partial<PersistedRoadexState> | unknown, now = Date.now()): PersistedRoadexState {
  const timestamp = new Date(now).toISOString();
  const safeState = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  const safeSessions = Array.isArray(safeState.sessions) ? safeState.sessions as unknown[] : [];
  const safeApprovalWaits = Array.isArray(safeState.approvalWaits) ? safeState.approvalWaits as unknown[] : [];
  const safeStreamEvents = Array.isArray(safeState.streamEvents) ? safeState.streamEvents as unknown[] : [];
  const safeAuditEvents = Array.isArray(safeState.auditEvents) ? safeState.auditEvents as unknown[] : [];
  const safeManagedThreadClaims = Array.isArray(safeState.managedThreadClaims) ? safeState.managedThreadClaims as unknown[] : [];
  const safeDeviceArtifacts = Array.isArray(safeState.deviceArtifacts) ? safeState.deviceArtifacts as unknown[] : [];
  const safeDeviceBridgeRequests = Array.isArray(safeState.deviceBridgeRequests)
    ? safeState.deviceBridgeRequests as unknown[]
    : [];
  const safeDeviceBridgeApprovals = Array.isArray(safeState.deviceBridgeApprovals)
    ? safeState.deviceBridgeApprovals as unknown[]
    : [];
  const safeDeviceBridgeOperations = Array.isArray(safeState.deviceBridgeOperations)
    ? safeState.deviceBridgeOperations as unknown[]
    : [];
  const safeDeviceInventoryBindings = Array.isArray(safeState.deviceInventoryBindings)
    ? safeState.deviceInventoryBindings as unknown[]
    : [];
  const safeDeviceDescriptorObservations = Array.isArray(safeState.deviceDescriptorObservations)
    ? safeState.deviceDescriptorObservations as unknown[]
    : [];
  const legacyTimeoutSessions = legacyTimeoutBlockedSessionIds(safeStreamEvents as StreamEvent[]);
  return {
    sessions: safeSessions.map((session: unknown) => {
      const safeSession = session as Partial<RoadexSession>;
  return {
    ...(safeSession as RoadexSession),
    lifecycle: safeSession.lifecycle === 'streaming'
      || safeSession.lifecycle === 'pending'
      || (safeSession.lifecycle === 'blocked'
        && safeSession.id !== undefined
        && legacyTimeoutSessions.has(safeSession.id))
      ? 'ready'
      : safeSession.lifecycle,
    runActivity: undefined,
    deviceBridge: 'disabled',
    createdAt: safeSession.createdAt ?? timestamp,
    updatedAt: safeSession.updatedAt ?? safeSession.createdAt ?? timestamp,
    codexThreadId: cleanOptionalString(safeSession.codexThreadId),
    managedThreadId: cleanOptionalString(safeSession.managedThreadId),
  } as RoadexSession;
    }),
    approvalWaits: safeApprovalWaits.flatMap((record) => sanitizeApprovalWait(record) ?? []),
    streamEvents: safeStreamEvents as StreamEvent[],
    auditEvents: safeAuditEvents as AuditEvent[],
    managedThreadClaims: safeManagedThreadClaims.flatMap((claim) => {
      if (claim === null || typeof claim !== 'object') return [];
      const safeClaim = claim as Partial<ManagedThreadClaim>;
      const threadId = cleanOptionalString(safeClaim.threadId);
      const userId = cleanOptionalString(safeClaim.userId);
      const claimedAt = cleanOptionalString(safeClaim.claimedAt);
      if (threadId === undefined || userId === undefined || claimedAt === undefined) return [];
      return [{ threadId, userId, claimedAt }];
    }),
    deviceArtifacts: safeDeviceArtifacts.flatMap((record) => sanitizeArtifact(record as DeviceArtifactMetadata) ?? []),
    deviceBridgeRequests: safeDeviceBridgeRequests.flatMap((record) => sanitizeRequest(record as DeviceBridgeRequestRecord) ?? []),
    deviceBridgeApprovals: safeDeviceBridgeApprovals.flatMap((record) => sanitizeApproval(record as DeviceBridgeApprovalRecord) ?? []),
    deviceBridgeOperations: safeDeviceBridgeOperations.flatMap((record) => sanitizeOperation(record as DeviceBridgeOperationRecord) ?? []),
    deviceInventoryBindings: safeDeviceInventoryBindings.flatMap((record) => sanitizeInventoryBinding(record as DeviceInventoryBindingRecord) ?? []),
    deviceDescriptorObservations: safeDeviceDescriptorObservations.flatMap((record) => sanitizeDescriptorObservation(record as DeviceDescriptorObservationRecord) ?? []),
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

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
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

function sanitizeApprovalWait(record: unknown): ApprovalWaitRecord | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const candidate = record as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(candidate);
  for (const key of ownKeys) {
    if (typeof key !== 'string') return undefined;
    if (!APPROVAL_WAIT_ALLOWED_KEYS.has(key)) return undefined;
  }
  const recordKeys = ownKeys as string[];
  if (
    !APPROVAL_WAIT_REQUIRED_KEY_LIST.every((key) => recordKeys.includes(key))
  ) return undefined;
  if (!isApprovalAuthorityClass(candidate.authorityClass)) return undefined;
  const consoleSurface = consoleForAuthority(candidate.authorityClass);
  const decisionObservedAt = Object.hasOwn(candidate, 'decisionObservedAt')
    ? candidate.decisionObservedAt
    : undefined;
  const dispatchReservedAt = Object.hasOwn(candidate, 'dispatchReservedAt')
    ? candidate.dispatchReservedAt
    : undefined;
  const runnerRunId = Object.hasOwn(candidate, 'runnerRunId')
    ? candidate.runnerRunId
    : undefined;
  const resumedAt = Object.hasOwn(candidate, 'resumedAt')
    ? candidate.resumedAt
    : undefined;
  const hasSuccessorOfWaitId = Object.hasOwn(candidate, 'successorOfWaitId');
  const successorOfWaitId = hasSuccessorOfWaitId
    ? cleanCanonicalOpaqueString(candidate.successorOfWaitId, 128)
    : undefined;
  const checkAttempt = candidate.checkAttempt as number;
  const id = cleanCanonicalOpaqueString(candidate.id, 128);
  const sessionId = cleanCanonicalOpaqueString(candidate.sessionId, 128);
  const userId = cleanCanonicalOpaqueString(candidate.userId, 128);
  const projectId = cleanCanonicalOpaqueString(candidate.projectId, 128);
  const workspaceId = cleanCanonicalOpaqueString(candidate.workspaceId, 128);
  const managedThreadId = cleanCanonicalOpaqueString(candidate.managedThreadId, 128);
  const approvalRef = cleanCanonicalOpaqueString(candidate.approvalRef, 256);
  const resourceRef = cleanCanonicalOpaqueString(candidate.resourceRef, 256);
  const decisionVersion = cleanCanonicalOpaqueString(candidate.decisionVersion, 128);
  const continuationId = cleanCanonicalOpaqueString(candidate.continuationId, 256);
  if (!(
    id !== undefined &&
    sessionId !== undefined &&
    userId !== undefined &&
    projectId !== undefined &&
    workspaceId !== undefined &&
    managedThreadId !== undefined &&
    approvalRef !== undefined &&
    resourceRef !== undefined &&
    validBoundedString(candidate.consoleSurface, 16) &&
    candidate.consoleSurface === consoleSurface &&
    candidate.provider === 'overseer' &&
    validBoundedString(candidate.subject, 256) &&
    isApprovalWaitState(candidate.state) &&
    decisionVersion !== undefined &&
    continuationId !== undefined &&
    Number.isSafeInteger(checkAttempt) &&
    checkAttempt >= 0 &&
    validIsoDate(candidate.nextCheckAt) &&
    validIsoDate(candidate.createdAt) &&
    validIsoDate(candidate.updatedAt) &&
    validOptionalIsoDate(decisionObservedAt) &&
    validOptionalIsoDate(dispatchReservedAt) &&
    validOptionalBoundedString(runnerRunId, 256) &&
    (!hasSuccessorOfWaitId || successorOfWaitId !== undefined) &&
    validOptionalIsoDate(resumedAt)
  )) return undefined;
  return {
    id,
    sessionId,
    userId,
    projectId,
    workspaceId,
    managedThreadId,
    provider: 'overseer',
    approvalRef,
    resourceRef,
    authorityClass: candidate.authorityClass,
    consoleSurface,
    subject: cleanOptionalString(candidate.subject)!,
    state: candidate.state,
    decisionVersion,
    continuationId,
    checkAttempt,
    nextCheckAt: cleanOptionalIsoDate(candidate.nextCheckAt)!,
    createdAt: cleanOptionalIsoDate(candidate.createdAt)!,
    updatedAt: cleanOptionalIsoDate(candidate.updatedAt)!,
    ...(Object.hasOwn(candidate, 'decisionObservedAt') && decisionObservedAt
      ? { decisionObservedAt: cleanOptionalIsoDate(decisionObservedAt) }
      : {}),
    ...(Object.hasOwn(candidate, 'dispatchReservedAt') && dispatchReservedAt
      ? { dispatchReservedAt: cleanOptionalIsoDate(dispatchReservedAt) }
      : {}),
    ...(Object.hasOwn(candidate, 'runnerRunId') && runnerRunId
      ? { runnerRunId: cleanOptionalString(runnerRunId)! }
      : {}),
    ...(hasSuccessorOfWaitId && successorOfWaitId
      ? { successorOfWaitId }
      : {}),
    ...(Object.hasOwn(candidate, 'resumedAt') && resumedAt
      ? { resumedAt: cleanOptionalIsoDate(resumedAt) }
      : {}),
  };
}

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

const APPROVAL_WAIT_REQUIRED_KEYS = new Set([
  'id',
  'sessionId',
  'userId',
  'projectId',
  'workspaceId',
  'managedThreadId',
  'provider',
  'approvalRef',
  'resourceRef',
  'authorityClass',
  'consoleSurface',
  'subject',
  'state',
  'decisionVersion',
  'continuationId',
  'checkAttempt',
  'nextCheckAt',
  'createdAt',
  'updatedAt',
]);

const APPROVAL_WAIT_ALLOWED_KEYS = new Set([
  ...APPROVAL_WAIT_REQUIRED_KEYS,
  'decisionObservedAt',
  'dispatchReservedAt',
  'runnerRunId',
  'successorOfWaitId',
  'resumedAt',
]);

const APPROVAL_WAIT_REQUIRED_KEY_LIST = [...APPROVAL_WAIT_REQUIRED_KEYS];

const APPROVAL_AUTHORITY_CLASSES: ApprovalAuthorityClass[] = ['privileged-operation', 'project-workflow'];

function isApprovalAuthorityClass(value: unknown): value is ApprovalAuthorityClass {
  return APPROVAL_AUTHORITY_CLASSES.includes(value as ApprovalAuthorityClass);
}

function isApprovalWaitState(value: unknown): value is ApprovalWaitState {
  return APPROVAL_WAIT_STATES.includes(value as ApprovalWaitState);
}

const APPROVAL_WAIT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function validIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(APPROVAL_WAIT_DATE_RE);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = Number((match[7] ?? '').padEnd(3, '0'));
  if (
    Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)
    || Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(second) || Number.isNaN(fraction)
  ) return false;
  if (
    month < 1 || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
  ) return false;
  if (fraction < 0 || fraction > 999) return false;
  const expectedSeconds = Date.parse(value);
  if (Number.isNaN(expectedSeconds)) return false;
  const offsetHours = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinutes = match[8] === 'Z' ? 0 : Number(match[11]);
  const timezoneMinutes = match[8] === 'Z'
    ? 0
    : ((offsetHours * 60 + offsetMinutes) * (match[9] === '-' ? -1 : 1));
  if (
    Number.isNaN(timezoneMinutes)
    || hour > 23
    || minute > 59
    || Number.isNaN(offsetHours)
    || Number.isNaN(offsetMinutes)
    || offsetHours > 14
    || offsetMinutes > 59
    || (offsetHours === 14 && offsetMinutes !== 0)
  ) return false;
  const utcTime = Date.UTC(year, month - 1, day, hour, minute, second, fraction) - timezoneMinutes * 60000;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return utcTime === parsed.getTime();
}

function validOptionalIsoDate(value: unknown): boolean {
  return value === undefined || validIsoDate(value);
}

function validBoundedString(value: unknown, maxLength: number): boolean {
  const cleaned = cleanOptionalString(value);
  return Boolean(cleaned && cleaned.length <= maxLength);
}

function validCanonicalOpaqueString(value: unknown, maxLength: number): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || (0x7f <= codePoint && codePoint <= 0x9f)) return false;
  }
  return true;
}

function cleanCanonicalOpaqueString(value: unknown, maxLength: number): string | undefined {
  return validCanonicalOpaqueString(value, maxLength) ? (value as string) : undefined;
}

function validOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || validBoundedString(value, maxLength);
}

function cleanOptionalIsoDate(value: unknown): string | undefined {
  return typeof value === 'string' ? new Date(value).toISOString() : undefined;
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

const PERSISTED_STATE_KEYS = [
  'sessions',
  'streamEvents',
  'auditEvents',
  'managedThreadClaims',
  'approvalWaits',
  'deviceArtifacts',
  'deviceBridgeRequests',
  'deviceBridgeApprovals',
  'deviceBridgeOperations',
  'deviceInventoryBindings',
  'deviceDescriptorObservations',
].sort();

function parseAuthoritativeState(value: unknown): PersistedRoadexState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== PERSISTED_STATE_KEYS.join(',')) return undefined;
  if (PERSISTED_STATE_KEYS.some((key) => !Array.isArray(candidate[key]))) return undefined;
  const state = candidate as unknown as PersistedRoadexState;
  const canonical = serializeState(state, {
    now: Date.now(),
    maxSessions: Number.MAX_SAFE_INTEGER,
    maxStreamEvents: Number.MAX_SAFE_INTEGER,
    maxAuditEvents: Number.MAX_SAFE_INTEGER,
    sessionRetentionMs: Number.MAX_SAFE_INTEGER,
    maxDeviceArtifacts: Number.MAX_SAFE_INTEGER,
    maxDeviceRequests: Number.MAX_SAFE_INTEGER,
    maxDeviceApprovals: Number.MAX_SAFE_INTEGER,
    maxDeviceOperations: Number.MAX_SAFE_INTEGER,
    deviceBridgeRetentionMs: Number.MAX_SAFE_INTEGER,
    maxApprovalWaits: Number.MAX_SAFE_INTEGER,
    approvalWaitRetentionMs: Number.MAX_SAFE_INTEGER,
  });
  return deepEqual(canonical, state) && strictSessionRecords(state.sessions)
    && strictStreamRecords(state.streamEvents)
    && strictAuditRecords(state.auditEvents)
    && strictManagedThreadClaims(state.managedThreadClaims)
    ? cloneState(state)
    : undefined;
}

const SESSION_REQUIRED_KEYS = [
  'id', 'userId', 'workspace', 'lifecycle', 'runnerMode', 'transport',
  'deviceBridge', 'gates', 'createdAt', 'updatedAt',
];
const SESSION_OPTIONAL_KEYS = ['codexThreadId', 'managedThreadId', 'waitingApproval', 'runActivity'];

function strictSessionRecords(records: RoadexSession[]): boolean {
  return records.every((record) => {
    if (!record || typeof record !== 'object') return false;
    const keys = Object.keys(record).sort();
    const allowed = new Set([...SESSION_REQUIRED_KEYS, ...SESSION_OPTIONAL_KEYS]);
    if (keys.some((key) => !allowed.has(key)) || SESSION_REQUIRED_KEYS.some((key) => !keys.includes(key))) {
      return false;
    }
    const workspace = record.workspace;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return false;
    if (Object.keys(workspace).sort().join(',') !== 'id,name,root') return false;
    return typeof record.id === 'string'
      && typeof record.userId === 'string'
      && typeof workspace.id === 'string'
      && typeof workspace.name === 'string'
      && typeof workspace.root === 'string'
      && Array.isArray(record.gates)
      && typeof record.createdAt === 'string'
      && typeof record.updatedAt === 'string';
  });
}

function strictStreamRecords(records: StreamEvent[]): boolean {
  return records.every((record) => (
    record !== null
    && typeof record === 'object'
    && Object.keys(record).sort().join(',') === 'at,id,kind,message,sessionId'
    && typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.kind === 'string'
    && typeof record.message === 'string'
    && typeof record.at === 'string'
  ));
}

function strictAuditRecords(records: AuditEvent[]): boolean {
  return records.every((record) => (
    record !== null
    && typeof record === 'object'
    && Object.keys(record).sort().join(',') === 'action,actorId,at,id,outcome,resource,summary'
    && typeof record.id === 'string'
    && typeof record.at === 'string'
    && typeof record.actorId === 'string'
    && typeof record.action === 'string'
    && typeof record.outcome === 'string'
    && typeof record.resource === 'string'
    && typeof record.summary === 'string'
  ));
}

function strictManagedThreadClaims(records: ManagedThreadClaim[]): boolean {
  return records.every((record) => (
    record !== null
    && typeof record === 'object'
    && Object.keys(record).sort().join(',') === 'claimedAt,threadId,userId'
    && typeof record.threadId === 'string'
    && typeof record.userId === 'string'
    && typeof record.claimedAt === 'string'
  ));
}

function projectRegistrationSession(
  session: RoadexSession,
): Pick<RoadexSession, 'id' | 'lifecycle' | 'waitingApproval'> {
  return {
    id: session.id,
    lifecycle: session.lifecycle,
    ...(session.waitingApproval ? { waitingApproval: { ...session.waitingApproval } } : {}),
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
