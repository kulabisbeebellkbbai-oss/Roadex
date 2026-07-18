import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  DeviceArtifactMetadata,
  DeviceBridgeApprovalRecord,
  DeviceBridgeOperationRecord,
  DeviceInventoryBindingRecord,
} from '../shared/deviceBridgeContracts.js';
import type { RoadexSession, UserProfile } from '../shared/sessionContracts.js';

export type DeviceBridgeStore = {
  artifacts: Map<string, DeviceArtifactMetadata>;
  approvals: Map<string, DeviceBridgeApprovalRecord>;
  operations: Map<string, DeviceBridgeOperationRecord>;
  inventoryBindings: Map<string, DeviceInventoryBindingRecord>;
};

type ServiceOptions = {
  enabledForTestsOnly?: boolean;
  now?: () => number;
  createId?: () => string;
  createSecret?: () => string;
  resolveSession?: (user: UserProfile, sessionId: string) => RoadexSession | undefined;
  resolveInventoryBinding?: (projectId: string, inventoryBindingId: string) => DeviceInventoryBindingRecord | undefined;
};

type Denied = { ok: false; reason: string };
type Allowed<T> = { ok: true; value: T };

export function createDeviceBridgeService(store: DeviceBridgeStore, options: ServiceOptions = {}) {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'));

  function disabled(): Denied | undefined {
    return (options.enabledForTestsOnly === true &&
      options.resolveSession &&
      options.resolveInventoryBinding)
      ? undefined
      : { ok: false, reason: 'Device bridge operations are disabled.' };
  }

  function currentSession(user: UserProfile, sessionId: string, projectId: string): RoadexSession | undefined {
    const session = options.resolveSession?.(user, sessionId);
    return session?.userId === user.id && session.lifecycle === 'ready' && session.workspace.id === projectId
      ? session
      : undefined;
  }

  function activeBinding(
    projectId: string,
    inventoryBindingId: string,
    deviceIdentityTag: string,
  ): DeviceInventoryBindingRecord | undefined {
    const binding = options.resolveInventoryBinding?.(projectId, inventoryBindingId);
    const normalizedTag = deviceIdentityTag.toLowerCase();
    return binding &&
      binding.id === inventoryBindingId &&
      binding.projectId === projectId &&
      binding.allowedOperation === 'esp32.flash' &&
      binding.lifecycle === 'active' &&
      !binding.revokedAt &&
      /^[a-f0-9]{64}$/i.test(binding.deviceIdentityTag) &&
      binding.deviceIdentityTag.toLowerCase() === normalizedTag
      ? binding
      : undefined;
  }

  return {
    requestApproval(
      user: UserProfile,
      session: RoadexSession,
      artifactId: string,
      inventoryBindingId: string,
    ): Allowed<DeviceBridgeApprovalRecord> | Denied {
      const gate = disabled();
      if (gate) return gate;
      const artifact = store.artifacts.get(artifactId);
      const binding = options.resolveInventoryBinding?.(session.workspace.id, inventoryBindingId);
      if (
        !artifact ||
        !currentSession(user, session.id, session.workspace.id) ||
        artifact.sessionId !== session.id ||
        artifact.projectId !== session.workspace.id ||
        !binding ||
        !activeBinding(session.workspace.id, inventoryBindingId, binding.deviceIdentityTag)
      ) return { ok: false, reason: 'Device bridge approval is unavailable.' };
      const createdAt = new Date(now()).toISOString();
      const credential = createSecret();
      const record: DeviceBridgeApprovalRecord = {
        id: createId(),
        requestId: createId(),
        userId: user.id,
        sessionId: session.id,
        projectId: session.workspace.id,
        artifactId,
        artifactSha256: artifact.sha256.toLowerCase(),
        inventoryBindingId,
        deviceIdentityTag: binding.deviceIdentityTag.toLowerCase(),
        credentialDigest: digest(credential),
        operation: 'esp32.flash',
        status: 'pending',
        createdAt,
        expiresAt: new Date(now() + 5 * 60_000).toISOString(),
      };
      store.approvals.set(record.id, record);
      return { ok: true, value: record };
    },

    startProbe(user: UserProfile, approvalId: string): Allowed<{ operation: DeviceBridgeOperationRecord; credential: string }> | Denied {
      const gate = disabled();
      if (gate) return gate;
      const approval = store.approvals.get(approvalId);
      const artifact = approval && store.artifacts.get(approval.artifactId);
      if (
        !approval ||
        approval.userId !== user.id ||
        approval.status !== 'pending' ||
        expired(approval.expiresAt, now()) ||
        !currentSession(user, approval.sessionId, approval.projectId) ||
        !artifact ||
        artifact.sessionId !== approval.sessionId ||
        artifact.projectId !== approval.projectId ||
        artifact.sha256.toLowerCase() !== approval.artifactSha256 ||
        !activeBinding(approval.projectId, approval.inventoryBindingId, approval.deviceIdentityTag)
      ) {
        return { ok: false, reason: 'Device bridge approval is unavailable.' };
      }
      approval.status = 'consumed';
      const credential = createSecret();
      const createdAt = new Date(now()).toISOString();
      const operation: DeviceBridgeOperationRecord = {
        id: createId(),
        approvalId,
        userId: user.id,
        sessionId: approval.sessionId,
        projectId: approval.projectId,
        artifactId: approval.artifactId,
        artifactSha256: approval.artifactSha256,
        inventoryBindingId: approval.inventoryBindingId,
        deviceIdentityTag: approval.deviceIdentityTag,
        operation: 'esp32.flash',
        phase: 'probe',
        credentialDigest: digest(credential),
        nextEventSequence: 0,
        phaseExpiresAt: new Date(now() + 5 * 60_000).toISOString(),
        reportingExpiresAt: new Date(now() + 15 * 60_000).toISOString(),
        createdAt,
        updatedAt: createdAt,
      };
      store.operations.set(operation.id, operation);
      return { ok: true, value: { operation, credential } };
    },

    submitProbe(
      user: UserProfile,
      operationId: string,
      credential: string,
      actualDeviceIdentityTag: string,
      artifactSha256: string,
    ): Allowed<{ challenge: string }> | Denied {
      const gate = disabled();
      if (gate) return gate;
      const operation = authorizedOperation(store, user, operationId, credential, 'probe', now());
      const artifact = operation && store.artifacts.get(operation.artifactId);
      if (
        !operation ||
        !currentSession(user, operation.sessionId, operation.projectId) ||
        !artifact ||
        artifact.sessionId !== operation.sessionId ||
        artifact.projectId !== operation.projectId ||
        artifact.sha256.toLowerCase() !== operation.artifactSha256 ||
        !activeBinding(operation.projectId, operation.inventoryBindingId, operation.deviceIdentityTag) ||
        actualDeviceIdentityTag.toLowerCase() !== operation.deviceIdentityTag ||
        artifactSha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
        artifactSha256.toLowerCase() !== operation.artifactSha256
      ) {
        if (operation) closeOperation(operation, 'failed', now());
        return { ok: false, reason: 'Device identity or artifact verification failed.' };
      }
      const challenge = createSecret();
      operation.phase = 'confirmation';
      operation.actualDeviceIdentityTag = actualDeviceIdentityTag.toLowerCase();
      operation.verifiedArtifactSha256 = artifactSha256.toLowerCase();
      operation.confirmationChallengeDigest = digest(challenge);
      operation.phaseExpiresAt = new Date(now() + 60_000).toISOString();
      operation.updatedAt = new Date(now()).toISOString();
      return { ok: true, value: { challenge } };
    },

    authorizeWrite(
      user: UserProfile,
      operationId: string,
      credential: string,
      challenge: string,
    ): Allowed<{ destructiveNonce: string }> | Denied {
      const gate = disabled();
      if (gate) return gate;
      const operation = authorizedOperation(store, user, operationId, credential, 'confirmation', now());
      const artifact = operation && store.artifacts.get(operation.artifactId);
      if (
        !operation ||
        !currentSession(user, operation.sessionId, operation.projectId) ||
        !artifact ||
        artifact.sessionId !== operation.sessionId ||
        artifact.projectId !== operation.projectId ||
        artifact.sha256.toLowerCase() !== operation.artifactSha256 ||
        operation.verifiedArtifactSha256 !== operation.artifactSha256 ||
        operation.actualDeviceIdentityTag !== operation.deviceIdentityTag ||
        !activeBinding(operation.projectId, operation.inventoryBindingId, operation.deviceIdentityTag) ||
        !matchesDigest(challenge, operation.confirmationChallengeDigest)
      ) {
        return { ok: false, reason: 'Device write confirmation is unavailable.' };
      }
      const destructiveNonce = createSecret();
      operation.phase = 'destructive';
      operation.confirmationChallengeDigest = undefined;
      operation.destructiveNonceDigest = digest(destructiveNonce);
      operation.phaseExpiresAt = new Date(now() + 2 * 60_000).toISOString();
      operation.reportingExpiresAt = new Date(now() + 15 * 60_000).toISOString();
      operation.updatedAt = new Date(now()).toISOString();
      return { ok: true, value: { destructiveNonce } };
    },

    revokeSession(sessionId: string): void {
      for (const approval of store.approvals.values()) {
        if (approval.sessionId === sessionId && approval.status === 'pending') approval.status = 'revoked';
      }
      for (const operation of store.operations.values()) {
        if (operation.sessionId !== sessionId || terminal(operation.phase)) continue;
        if (operation.phase === 'destructive') {
          operation.phase = 'reporting';
          operation.destructiveNonceDigest = undefined;
          operation.updatedAt = new Date(now()).toISOString();
        } else {
          closeOperation(operation, 'cancelled', now());
        }
      }
    },
  };
}

function authorizedOperation(
  store: DeviceBridgeStore,
  user: UserProfile,
  operationId: string,
  credential: string,
  phase: DeviceBridgeOperationRecord['phase'],
  now: number,
): DeviceBridgeOperationRecord | undefined {
  const operation = store.operations.get(operationId);
  if (
    !operation ||
    operation.userId !== user.id ||
    operation.phase !== phase ||
    expired(operation.phaseExpiresAt, now) ||
    !matchesDigest(credential, operation.credentialDigest)
  ) return undefined;
  return operation;
}

function closeOperation(operation: DeviceBridgeOperationRecord, phase: 'failed' | 'cancelled', now: number): void {
  operation.phase = phase;
  operation.confirmationChallengeDigest = undefined;
  operation.destructiveNonceDigest = undefined;
  operation.updatedAt = new Date(now).toISOString();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matchesDigest(value: string, expected?: string): boolean {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = Buffer.from(digest(value), 'hex');
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function expired(value: string, now: number): boolean {
  return Date.parse(value) <= now;
}

function terminal(phase: DeviceBridgeOperationRecord['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}
