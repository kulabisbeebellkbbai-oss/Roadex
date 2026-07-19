import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { createStreamEvent } from '../src/server/mockRunner';
import { createMemoryPersistence, type StatePersistence } from '../src/server/statePersistence';
import {
  approveDeviceBridgeRequest,
  bootstrap,
  closeSession,
  createDeviceInventoryBinding,
  createInitialState,
  createMockSession,
  createSessionFromApi,
  cancelSessionRun,
  listDeviceArtifactMetadata,
  listDeviceInventoryBindings,
  listArchivedSessions,
  observeDeviceDescriptor,
  reopenSession,
  registerDeviceArtifactMetadata,
  requestDeviceBridgeIntake,
  revokeDeviceArtifactMetadata,
  revokeDeviceInventoryBinding,
  streamEventsForSession,
  subscribeToSessionStream,
  submitPrompt,
  startDeviceBridgeProbe,
  submitDeviceBridgeProbe,
} from '../src/server/sessionService';
import type { UserProfile, WorkspaceRef } from '../src/shared/sessionContracts';
import type {
  DeviceArtifactMetadata,
  DeviceBridgeRequestRecord,
  DeviceInventoryBindingRecord,
} from '../src/shared/deviceBridgeContracts';
import type { RunnerPromptRequest, SessionRunner } from '../src/server/codexRunner';

const workspace: WorkspaceRef = {
  id: 'roadex',
  name: 'Roadex Portal',
  root: process.cwd(),
};

function fakeRunner(result: 'ok' | 'failed' = 'ok', codexThreadId?: string): SessionRunner {
  let sessions = 0;
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      sessions += 1;
      const now = new Date().toISOString();
      return {
        id: `codex-${selectedWorkspace.id}-${sessions}`,
        userId,
        workspace: selectedWorkspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async runPrompt({ session, prompt, onEvent, signal }: RunnerPromptRequest) {
      const events = [createStreamEvent(session.id, 'assistant', `Codex read: ${prompt}`)];
      for (const event of events) {
        if (signal?.aborted) break;
        onEvent?.(event);
      }
      if (result === 'failed') {
        return { ok: false, events, reason: 'runner_failed', codexThreadId };
      }
      return { ok: true, events, exitCode: 0, codexThreadId };
    },
  };
}

function controllableRunner(): SessionRunner {
  let sessions = 0;
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      sessions += 1;
      const now = new Date().toISOString();
      return {
        id: `codex-${selectedWorkspace.id}-${sessions}`,
        userId,
        workspace: selectedWorkspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async runPrompt({ session, onEvent, signal }: RunnerPromptRequest) {
      onEvent?.(createStreamEvent(session.id, 'assistant', 'runner started'));
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const event = createStreamEvent(session.id, 'system', 'cancel observed');
      onEvent?.(event);
      return { ok: false, events: [event], reason: 'runner_cancelled' };
    },
  };
}

function threadRecordingRunner(observedThreads: Array<string | undefined>): SessionRunner {
  let sessions = 0;
  let prompts = 0;
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      sessions += 1;
      const now = new Date().toISOString();
      return {
        id: `codex-${selectedWorkspace.id}-${sessions}`,
        userId,
        workspace: selectedWorkspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async runPrompt({ session, prompt, onEvent }: RunnerPromptRequest) {
      prompts += 1;
      observedThreads.push(session.codexThreadId);
      const events = [createStreamEvent(session.id, 'assistant', `Codex read: ${prompt}`)];
      for (const event of events) {
        onEvent?.(event);
      }
      return { ok: true, events, exitCode: 0, codexThreadId: `thread-${prompts}` };
    },
  };
}

describe('createMockSession', () => {
  it('requires authentication before creating a session', () => {
    const response = createMockSession({ workspace });

    expect(response).toMatchObject({
      ok: false,
      gate: 'auth',
    });
  });

  it('keeps device bridge access disabled in the first milestone', () => {
    const response = createMockSession({
      userId: 'user-1',
      workspace,
      requestedDeviceBridge: true,
    });

    expect(response).toMatchObject({
      ok: false,
      gate: 'device-bridge',
    });
  });

  it('reports only the disabled device bridge foundation in bootstrap', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const result = await bootstrap(state, mockUser);

    expect(result.deviceBridgePolicy).toEqual({
      state: 'disabled',
      approvedFoundation: true,
      operations: ['esp32.flash'],
      requestIntakeEnabled: false,
      descriptorObservationEnabled: false,
      operationsEnabled: false,
      reason: expect.stringContaining('disabled'),
    });
    expect(state.deviceArtifacts.size).toBe(0);
    expect(state.deviceBridgeApprovals.size).toBe(0);
    expect(state.deviceBridgeOperations.size).toBe(0);
  });

  it('creates a ready mock session for an authenticated user and approved workspace', () => {
    const response = createMockSession({
      userId: 'user-1',
      workspace,
    });

    expect(response).toMatchObject({
      ok: true,
      session: {
        lifecycle: 'ready',
        runnerMode: 'mock',
        transport: 'sse',
        deviceBridge: 'disabled',
      },
    });
  });
});

describe('Roadex session service', () => {
  it('observes an allowlisted USB descriptor without persisting or returning the raw serial', async () => {
    const enabled = process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED;
    const descriptorKey = process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY;
    const auditKey = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    try {
      process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY = 'descriptor-observation-hmac-key-test-32';
      process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
      const persistence = createMemoryPersistence();
      const state = createInitialState(fakeRunner(), persistence);
      const user = protectedGatewayUser();
      const created = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const binding = seedDeviceInventoryBinding(state);

      const result = observeDeviceDescriptor(state, user, created.session.id, {
        inventoryBindingId: binding.id,
        vendorId: 0x10c4,
        productId: 0xea60,
        serialNumber: 'Private-USB-Serial',
      });

      expect(result).toMatchObject({
        ok: true,
        observation: { status: 'observed', verification: 'unverified' },
      });
      expect(JSON.stringify(result)).not.toContain('Private-USB-Serial');
      expect(JSON.stringify(result)).not.toContain('descriptorFingerprint');
      const stored = [...state.deviceDescriptorObservations.values()][0];
      expect(stored.descriptorFingerprint).toBe(createHmac('sha256', 'descriptor-observation-hmac-key-test-32')
        .update('roadex-usb-descriptor:v1:4292:60000:private-usb-serial')
        .digest('hex'));
      expect(JSON.stringify(persistence.load())).not.toContain('Private-USB-Serial');
      expect(state.deviceBridgeRequests.size).toBe(0);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED', enabled);
      restoreEnv('ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY', descriptorKey);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', auditKey);
    }
  });

  it('verifies or rejects a probed ESP32 MAC against the inventory binding without creating an operation', async () => {
    const enabled = process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED;
    const descriptorKey = process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY;
    const identityKey = process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
    const auditKey = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    try {
      process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY = 'descriptor-observation-hmac-key-test-32';
      process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = testIdentityHmacKey();
      process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const created = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const expectedMacTag = createHmac('sha256', testIdentityHmacKey())
        .update('roadex-device-mac:v1:roadex:aa:bb:cc:dd:ee:ff')
        .digest('hex');
      const binding = seedDeviceInventoryBinding(state, 'binding', 'roadex', { deviceMacTag: expectedMacTag });

      const verified = observeDeviceDescriptor(state, user, created.session.id, {
        inventoryBindingId: binding.id,
        vendorId: 0x10c4,
        productId: 0xea60,
        deviceMac: 'AA-BB-CC-DD-EE-FF',
      });
      const mismatch = observeDeviceDescriptor(state, user, created.session.id, {
        inventoryBindingId: binding.id,
        vendorId: 0x10c4,
        productId: 0xea60,
        deviceMac: '00:11:22:33:44:55',
      });

      expect(verified).toMatchObject({ ok: true, observation: { verification: 'verified' } });
      expect(mismatch).toMatchObject({ ok: true, observation: { verification: 'mismatch' } });
      expect(JSON.stringify(verified)).not.toContain('aa:bb:cc:dd:ee:ff');
      expect(JSON.stringify(mismatch)).not.toContain('00:11:22:33:44:55');
      expect(state.deviceBridgeRequests.size).toBe(0);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED', enabled);
      restoreEnv('ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY', descriptorKey);
      restoreEnv('ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY', identityKey);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', auditKey);
    }
  });

  it('rejects unsupported USB descriptors and leaves observation state unchanged', async () => {
    const enabled = process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED;
    const descriptorKey = process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY;
    const auditKey = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    try {
      process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY = 'descriptor-observation-hmac-key-test-32';
      process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const created = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const binding = seedDeviceInventoryBinding(state);
      expect(observeDeviceDescriptor(state, user, created.session.id, {
        inventoryBindingId: binding.id,
        vendorId: 1,
        productId: 2,
      })).toMatchObject({ ok: false, classification: 'schema' });
      expect(state.deviceDescriptorObservations.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED', enabled);
      restoreEnv('ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY', descriptorKey);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', auditKey);
    }
  });
  it('creates a session from a server-owned workspace id and records audit', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response).toMatchObject({
      ok: true,
      session: {
        userId: mockUser.id,
        runnerMode: 'codex',
      },
    });
    expect(state.audit.events.map((event) => event.action)).toContain('session.create');
  });

  it('rejects unknown workspace ids instead of accepting browser-supplied roots', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: '../roadex' });

    expect(response).toMatchObject({
      ok: false,
      gate: 'workspace',
    });
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      outcome: 'denied',
    });
  });

  it('rejects requested device bridge access and records denial', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, {
      workspaceId: 'roadex',
      requestedDeviceBridge: true,
    });

    expect(response).toMatchObject({
      ok: false,
      gate: 'device-bridge',
    });
    expect(state.audit.events.at(-1)).toMatchObject({
      resource: 'device-bridge',
      outcome: 'denied',
    });
  });

  it('keeps device bridge request intake default-off and records no request records', async () => {
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, protectedGatewayUser(), { workspaceId: 'roadex' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    seedDeviceArtifact(state, response.session.id);

    try {
      const intake = requestDeviceBridgeIntake(
        state,
        protectedGatewayUser(),
        response.session.id,
        validDeviceBridgeRequest(),
      );

      expect(intake).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge request denied.',
        classification: 'device-bridge',
      });
      expect(state.deviceBridgeRequests.size).toBe(0);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
      expect(state.audit.events.at(-1)).toMatchObject({
        action: 'security.denied',
        outcome: 'denied',
      });
      expect(state.audit.events.at(-1)?.resource).not.toBe(response.session.id);
      expect(state.audit.events.at(-1)?.summary).toContain('classification=device-bridge');
      expect(state.audit.events.at(-1)?.summary).not.toContain(protectedGatewayUser().id);
      expect(state.audit.events.at(-1)?.summary).not.toContain(response.session.id);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('creates only a pending device bridge request when intake is enabled and all bindings validate', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      response.session.codexThreadId = 'thread-roadex-bound';
      seedDeviceArtifact(state, response.session.id);
      const binding = seedDeviceInventoryBinding(state);

      const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());

      expect(intake).toMatchObject({
        ok: true,
        request: {
          userId: user.id,
          sessionId: response.session.id,
          projectId: 'roadex',
          artifactId: 'artifact',
          artifactSha256: 'a'.repeat(64),
          inventoryBindingId: binding.id,
          operation: 'esp32.flash',
          status: 'pending',
        },
      });
      expect(intake.ok && 'deviceIdentityTag' in intake.request).toBe(false);
      const stored = intake.ok ? state.deviceBridgeRequests.get(intake.request.id) : undefined;
      expect(stored).toMatchObject({
        inventoryBindingId: binding.id,
        deviceIdentityTag: binding.deviceIdentityTag,
      });
      expect(state.deviceBridgeRequests.size).toBe(1);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
      expect(response.session).toMatchObject({
        id: intake.ok ? intake.request.sessionId : response.session.id,
        userId: user.id,
        codexThreadId: 'thread-roadex-bound',
      });
      expect(state.audit.events.at(-1)).toMatchObject({
        action: 'device_bridge.request',
        outcome: 'allowed',
      });
      expect(state.audit.events.at(-1)?.actorId).not.toBe(user.id);
      expect(state.audit.events.at(-1)?.resource).not.toBe(response.session.id);
      expect(state.audit.events.at(-1)?.summary).toContain('classification=created');
      expect(state.audit.events.at(-1)?.summary).not.toContain(response.session.id);
      expect(state.audit.events.at(-1)?.summary).not.toContain(user.id);
      expect(state.audit.events.at(-1)?.summary).not.toContain('artifact');
      expect(state.audit.events.at(-1)?.summary).not.toContain('esp32:device');
      expect(state.audit.events.at(-1)?.summary).not.toContain(binding.id);
      expect(state.audit.events.at(-1)?.summary).not.toContain(binding.deviceIdentityTag);
      if (intake.ok) expect(state.audit.events.at(-1)?.summary).not.toContain(intake.request.id);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('shows an ordinary owner their pseudonymized bridge audit event through bootstrap', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user: UserProfile = {
        ...protectedGatewayUser(),
        id: 'ordinary-owner',
        roles: ['user'],
      };
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      seedDeviceArtifact(state, response.session.id);
      const binding = seedDeviceInventoryBinding(state);

      const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());
      expect(intake.ok).toBe(true);
      if (!intake.ok) return;
      const bootstrapped = await bootstrap(state, user);
      const bridgeAudit = bootstrapped.auditEvents.find((event) => event.action === 'device_bridge.request');

      expect(bridgeAudit).toBeDefined();
      expect(bridgeAudit).toMatchObject({
        action: 'device_bridge.request',
        outcome: 'allowed',
      });
      expect(bridgeAudit?.actorId).not.toBe(user.id);
      expect(bridgeAudit?.resource).not.toBe(response.session.id);
      expect(bridgeAudit?.summary).toContain('classification=created');
      expect(bridgeAudit?.summary).not.toContain(user.id);
      expect(bridgeAudit?.summary).not.toContain(response.session.id);
      expect(bridgeAudit?.summary).not.toContain(intake.request.id);
      expect(bridgeAudit?.summary).not.toContain(binding.id);
      expect(bridgeAudit?.summary).not.toContain(binding.deviceIdentityTag);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('approves one valid pending bridge request with a private digest-only approval record', async () => {
    const originalApproval = process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED;
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const artifact = seedDeviceArtifact(state, response.session.id);
      const binding = seedDeviceInventoryBinding(state);
      const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());
      expect(intake.ok).toBe(true);
      if (!intake.ok) return;

      const approval = approveDeviceBridgeRequest(state, user, intake.request.id);

      expect(approval).toMatchObject({
        ok: true,
        approval: {
          requestId: intake.request.id,
          sessionId: response.session.id,
          projectId: 'roadex',
          artifactId: artifact.id,
          artifactSha256: artifact.sha256,
          inventoryBindingId: binding.id,
          operation: 'esp32.flash',
          status: 'pending',
        },
      });
      expect(approval.ok && 'userId' in approval.approval).toBe(false);
      expect(approval.ok && 'deviceIdentityTag' in approval.approval).toBe(false);
      expect(approval.ok && 'credentialDigest' in approval.approval).toBe(false);
      expect(state.deviceBridgeRequests.get(intake.request.id)?.status).toBe('approved');
      expect(state.deviceBridgeApprovals.size).toBe(1);
      const stored = [...state.deviceBridgeApprovals.values()][0];
      expect(stored).toMatchObject({
        requestId: intake.request.id,
        userId: user.id,
        deviceIdentityTag: binding.deviceIdentityTag,
      });
      expect(stored.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.credentialDigest).not.toContain('bridge-approval');
      expect(state.deviceBridgeOperations.size).toBe(0);
      const audit = state.audit.events.at(-1);
      expect(audit).toMatchObject({ action: 'device_bridge.approval', outcome: 'allowed' });
      expect(audit?.summary).not.toContain(user.id);
      expect(audit?.summary).not.toContain(intake.request.id);
      expect(audit?.summary).not.toContain(binding.deviceIdentityTag);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED', originalApproval);
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('rejects duplicate and alternate approval retries without minting another approval', async () => {
    const originalApproval = process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED;
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      seedDeviceArtifact(state, response.session.id);
      seedDeviceInventoryBinding(state);
      const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());
      expect(intake.ok).toBe(true);
      if (!intake.ok) return;
      expect(approveDeviceBridgeRequest(state, user, intake.request.id).ok).toBe(true);

      expect(approveDeviceBridgeRequest(state, user, intake.request.id)).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge approval denied.',
        classification: 'request',
      });
      expect(approveDeviceBridgeRequest(state, { ...user, roles: ['user', 'admin'] }, intake.request.id)).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'request',
      });
      expect(state.deviceBridgeApprovals.size).toBe(1);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED', originalApproval);
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('starts and completes a probe-only operation without creating write authority', async () => {
    const names = [
      'ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED',
      'ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED',
      'ROADEX_DEVICE_BRIDGE_PROBE_ENABLED',
      'ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY',
      'ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY',
    ] as const;
    const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_PROBE_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
      process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = testIdentityHmacKey();
      const persistence = createMemoryPersistence();
      const state = createInitialState(fakeRunner(), persistence);
      const user = protectedGatewayUser();
      const session = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      if (!session.ok) return;
      const artifact = seedDeviceArtifact(state, session.session.id);
      const deviceMac = 'aa:bb:cc:dd:ee:ff';
      const macTag = createHmac('sha256', testIdentityHmacKey())
        .update(`roadex-device-mac:v1:roadex:${deviceMac}`)
        .digest('hex');
      seedDeviceInventoryBinding(state, 'binding', 'roadex', { deviceMacTag: macTag });
      const intake = requestDeviceBridgeIntake(state, user, session.session.id, validDeviceBridgeRequest());
      if (!intake.ok) return;
      const approval = approveDeviceBridgeRequest(state, user, intake.request.id);
      if (!approval.ok) return;

      const started = startDeviceBridgeProbe(state, user, approval.approval.id);
      expect(started).toMatchObject({ ok: true, operation: { phase: 'probe' } });
      if (!started.ok) return;
      expect(state.deviceBridgeApprovals.get(approval.approval.id)?.status).toBe('consumed');
      const verified = submitDeviceBridgeProbe(state, user, started.operation.id, {
        deviceMac,
        artifactSha256: artifact.sha256,
      });
      expect(verified).toMatchObject({ ok: true, operation: { phase: 'verified' } });
      expect(JSON.stringify(verified)).not.toContain(deviceMac);
      expect(state.deviceBridgeOperations.get(started.operation.id)).toMatchObject({
        phase: 'verified',
        verifiedArtifactSha256: artifact.sha256,
      });
      expect(state.deviceBridgeOperations.get(started.operation.id)?.confirmationChallengeDigest).toBeUndefined();
      expect(state.deviceBridgeOperations.get(started.operation.id)?.destructiveNonceDigest).toBeUndefined();
    } finally {
      for (const name of names) restoreEnv(name, originals[name]);
    }
  });

  it('closes a probe-only operation on identity mismatch', async () => {
    const names = [
      'ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED',
      'ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED',
      'ROADEX_DEVICE_BRIDGE_PROBE_ENABLED',
      'ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY',
      'ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY',
    ] as const;
    const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_PROBE_ENABLED = 'true';
      process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
      process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = testIdentityHmacKey();
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const session = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      if (!session.ok) return;
      const artifact = seedDeviceArtifact(state, session.session.id);
      const expectedMacTag = createHmac('sha256', testIdentityHmacKey())
        .update('roadex-device-mac:v1:roadex:aa:bb:cc:dd:ee:ff')
        .digest('hex');
      seedDeviceInventoryBinding(state, 'binding', 'roadex', { deviceMacTag: expectedMacTag });
      const intake = requestDeviceBridgeIntake(state, user, session.session.id, validDeviceBridgeRequest());
      if (!intake.ok) return;
      const approval = approveDeviceBridgeRequest(state, user, intake.request.id);
      if (!approval.ok) return;
      const started = startDeviceBridgeProbe(state, user, approval.approval.id);
      if (!started.ok) return;

      expect(submitDeviceBridgeProbe(state, user, started.operation.id, {
        deviceMac: '00:11:22:33:44:55',
        artifactSha256: artifact.sha256,
      })).toMatchObject({ ok: false, classification: 'identity_mismatch' });
      expect(state.deviceBridgeOperations.get(started.operation.id)?.phase).toBe('failed');
      expect(state.audit.events.at(-1)).toMatchObject({
        action: 'device_bridge.operation_probe',
        outcome: 'denied',
      });
    } finally {
      for (const name of names) restoreEnv(name, originals[name]);
    }
  });

  it('revalidates owner, session, artifact, binding, operation, tag, and expiry before approval', async () => {
    const originalApproval = process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED;
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const setup = async () => {
        const state = createInitialState(fakeRunner(), createMemoryPersistence());
        const user = protectedGatewayUser();
        const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error('session setup failed');
        seedDeviceArtifact(state, response.session.id);
        seedDeviceInventoryBinding(state);
        const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());
        expect(intake.ok).toBe(true);
        if (!intake.ok) throw new Error('intake setup failed');
        return { state, user, session: response.session, requestId: intake.request.id };
      };

      {
        const { state, user, requestId } = await setup();
        expect(approveDeviceBridgeRequest(state, { ...user, roles: ['user'] }, requestId)).toMatchObject({
          ok: false,
          classification: 'auth',
        });
        expect(approveDeviceBridgeRequest(state, { ...user, authMode: 'mock' }, requestId)).toMatchObject({
          ok: false,
          classification: 'auth',
        });
        expect(approveDeviceBridgeRequest(state, { ...user, id: 'other-user' }, requestId)).toMatchObject({
          ok: false,
          classification: 'auth',
        });
      }
      {
        const { state, user, session, requestId } = await setup();
        session.lifecycle = 'closed';
        expect(approveDeviceBridgeRequest(state, user, requestId)).toMatchObject({ ok: false, classification: 'session' });
      }
      {
        const { state, user, requestId } = await setup();
        const artifact = state.deviceArtifacts.get('artifact');
        if (artifact) state.deviceArtifacts.set('artifact', { ...artifact, sha256: 'b'.repeat(64) });
        expect(approveDeviceBridgeRequest(state, user, requestId)).toMatchObject({ ok: false, classification: 'artifact' });
      }
      {
        const { state, user, requestId } = await setup();
        const binding = state.deviceInventoryBindings.get('binding');
        if (binding) state.deviceInventoryBindings.set('binding', { ...binding, deviceIdentityTag: 'd'.repeat(64) });
        expect(approveDeviceBridgeRequest(state, user, requestId)).toMatchObject({ ok: false, classification: 'inventory' });
      }
      {
        const { state, user, requestId } = await setup();
        const binding = state.deviceInventoryBindings.get('binding');
        if (binding) state.deviceInventoryBindings.set('binding', { ...binding, allowedOperation: 'esp8266.flash' as 'esp32.flash' });
        expect(approveDeviceBridgeRequest(state, user, requestId)).toMatchObject({ ok: false, classification: 'inventory' });
      }
      {
        const { state, user, requestId } = await setup();
        const request = state.deviceBridgeRequests.get(requestId);
        if (request) state.deviceBridgeRequests.set(requestId, { ...request, expiresAt: new Date(Date.now() - 1_000).toISOString() });
        expect(approveDeviceBridgeRequest(state, user, requestId)).toMatchObject({ ok: false, classification: 'request' });
      }
      expect((await setup()).state.deviceBridgeApprovals.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED', originalApproval);
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('rolls back request approval, approval record, and audit mutation when approval persistence fails', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      seedDeviceArtifact(state, response.session.id);
      seedDeviceInventoryBinding(state);
      const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());
      expect(intake.ok).toBe(true);
      if (!intake.ok) return;
      const auditCount = state.audit.events.length;
      state.persistence = failingSavePersistence();

      expect(() => approveDeviceBridgeRequest(state, user, intake.request.id)).toThrow('injected persistence failure');
      expect(state.deviceBridgeRequests.get(intake.request.id)?.status).toBe('pending');
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.audit.events).toHaveLength(auditCount);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('keeps firmware artifact metadata registry default-off with no metadata or binding records', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    delete process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;

      expect(registerDeviceArtifactMetadata(state, user, response.session.id, validArtifactMetadataPayload())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'device-bridge',
      });
      expect(listDeviceArtifactMetadata(state, user, response.session.id)).toBeUndefined();
      expect(createDeviceInventoryBinding(state, user, validInventoryBindingPayload())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'device-bridge',
      });
      expect(listDeviceInventoryBindings(state, user, 'roadex')).toBeUndefined();
      expect(state.deviceArtifacts.size).toBe(0);
      expect(state.deviceInventoryBindings.size).toBe(0);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('registers server-produced firmware artifact metadata only for the owning gateway user', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;
    const fixture = createArtifactFixture('server-produced-firmware-v1');
    process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    process.env.ROADEX_WORKSPACES_JSON = workspaceEnv(fixture.root);
    try {
      const state = createInitialState(fakeRunner('ok', 'thread-from-run'), createMemoryPersistence());
      const user: UserProfile = { ...protectedGatewayUser(), id: 'artifact-owner', roles: ['user'] };
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const promptResult = submitPrompt(state, user, response.session.id, 'produce firmware metadata');
      expect(promptResult).toMatchObject({ accepted: true });
      await flushRunner();

      const registered = registerDeviceArtifactMetadata(state, user, response.session.id, validArtifactMetadataPayload());

      expect(registered).toMatchObject({
        ok: true,
        artifact: {
          projectId: 'roadex',
          sessionId: response.session.id,
          producerUserId: user.id,
          producerThreadId: 'thread-from-run',
          label: 'firmware.bin',
          byteLength: fixture.byteLength,
          mediaType: 'application/octet-stream',
          format: 'esp32-firmware-bin',
          sha256: fixture.sha256,
          status: 'active',
        },
      });
      if (!registered.ok) return;
      expect(registered.artifact).not.toHaveProperty('storageReference');
      expect(state.deviceArtifacts.get(registered.artifact.id)?.storageReference).toMatch(/^artifact-ref-/);
      expect(state.deviceArtifacts.get(registered.artifact.id)?.storageReference).not.toContain('/');
      expect(registered.artifact.id).toMatch(/^artifact-/);
      expect(Date.parse(registered.artifact.expiresAt)).toBeGreaterThan(Date.parse(registered.artifact.createdAt));
      expect(listDeviceArtifactMetadata(state, user, response.session.id)).toEqual([registered.artifact]);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
      const audit = state.audit.events.at(-1);
      expect(audit).toMatchObject({ action: 'device_bridge.artifact', outcome: 'allowed' });
      expect(audit?.actorId).not.toBe(user.id);
      expect(audit?.resource).not.toBe(response.session.id);
      expect(audit?.summary).toContain('classification=artifact_registered');
      expect(audit?.summary).not.toContain(user.id);
      expect(audit?.summary).not.toContain(response.session.id);
      expect(audit?.summary).not.toContain(registered.artifact.id);
      expect(audit?.summary).not.toContain('firmware.bin');
      expect(audit?.summary).not.toContain(fixture.sha256);

      const intruder = { ...protectedGatewayUser(), id: 'not-owner' };
      expect(listDeviceArtifactMetadata(state, intruder, response.session.id)).toBeUndefined();
      expect(listDeviceArtifactMetadata(state, { ...user, authMode: 'mock' }, response.session.id)).toBeUndefined();
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
      restoreEnv('ROADEX_WORKSPACES_JSON', originalWorkspaces);
    }
  });

  it('rejects unsafe project artifact references and client-supplied metadata without mutating state', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;
    const fixture = createArtifactFixture('server-produced-firmware-v1');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'roadex-outside-artifacts-'));
    writeProjectArtifact(outsideRoot, 'outside.bin', 'outside');
    symlinkSync(join(outsideRoot, 'outside.bin'), join(fixture.root, 'build', 'link.bin'));
    mkdirSync(join(fixture.root, 'build', 'directory.bin'));
    const oversizedPath = join(fixture.root, 'build', 'oversized.bin');
    const oversizedFd = openSync(oversizedPath, 'w');
    ftruncateSync(oversizedFd, 16 * 1024 * 1024 + 1);
    closeSync(oversizedFd);
    process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    process.env.ROADEX_WORKSPACES_JSON = workspaceEnv(fixture.root);
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const invalidPayloads = [
        { ...validArtifactMetadataPayload(), extra: true },
        { ...validArtifactMetadataPayload(), sha256: 'b'.repeat(64) },
        { ...validArtifactMetadataPayload(), byteLength: fixture.byteLength },
        { ...validArtifactMetadataPayload(), label: '../firmware.bin' },
        { ...validArtifactMetadataPayload(), label: 'firmware.hex' },
        { ...validArtifactMetadataPayload(), artifactPath: '../outside.bin' },
        { ...validArtifactMetadataPayload(), artifactPath: '/tmp/firmware.bin' },
        { ...validArtifactMetadataPayload(), artifactPath: 'build/link.bin' },
        { ...validArtifactMetadataPayload(), artifactPath: 'build/directory.bin', label: 'directory.bin' },
        { ...validArtifactMetadataPayload(), artifactPath: 'build/oversized.bin', label: 'oversized.bin' },
        { ...validArtifactMetadataPayload(), artifactPath: 'build/firmware.hex', label: 'firmware.bin' },
      ];

      for (const payload of invalidPayloads) {
        const result = registerDeviceArtifactMetadata(state, user, response.session.id, payload);
        expect(result).toMatchObject({ ok: false, classification: 'schema' });
      }
      expect(state.deviceArtifacts.size).toBe(0);
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
      restoreEnv('ROADEX_WORKSPACES_JSON', originalWorkspaces);
    }
  });

  it('revokes firmware artifact metadata without exposing bytes or creating operations', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;
    const fixture = createArtifactFixture('server-produced-firmware-v1');
    process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    process.env.ROADEX_WORKSPACES_JSON = workspaceEnv(fixture.root);
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const registered = registerDeviceArtifactMetadata(state, user, response.session.id, validArtifactMetadataPayload());
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;

      const revoked = revokeDeviceArtifactMetadata(state, user, response.session.id, registered.artifact.id);

      expect(revoked).toMatchObject({ ok: true, artifact: { id: registered.artifact.id, status: 'revoked' } });
      expect(revoked.ok && revoked.artifact).not.toHaveProperty('storageReference');
      expect(listDeviceArtifactMetadata(state, user, response.session.id)).toEqual([]);
      expect(JSON.stringify([...state.deviceArtifacts.values()])).not.toContain('firmwareBytes');
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
      restoreEnv('ROADEX_WORKSPACES_JSON', originalWorkspaces);
    }
  });

  it('creates and revokes owner-approved inventory bindings with HMAC device identity only', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    const originalIdentityHmac = process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = testIdentityHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const admin = protectedGatewayUser();
      const ordinary = { ...protectedGatewayUser(), id: 'ordinary', roles: ['user'] as UserProfile['roles'] };
      const rawIdentity = 'chip=ESP32 mac=AA:BB:CC:DD:EE:FF serial=USB-SERIAL-123';

      expect(createDeviceInventoryBinding(state, ordinary, validInventoryBindingPayload(rawIdentity))).toMatchObject({
        ok: false,
        classification: 'auth',
      });
      const created = createDeviceInventoryBinding(state, admin, validInventoryBindingPayload(rawIdentity));

      expect(created).toMatchObject({
        ok: true,
        binding: {
          projectId: 'roadex',
          allowedOperation: 'esp32.flash',
          secureBootExpected: 'required',
          flashEncryptionExpected: 'required',
          lifecycle: 'active',
          createdBy: admin.id,
        },
      });
      if (!created.ok) return;
      const expectedIdentityTag = createHmac('sha256', testIdentityHmacKey())
        .update(`roadex-device-bridge-identity:v1:roadex:${rawIdentity.toLowerCase()}`)
        .digest('hex');
      const auditKeyTag = createHmac('sha256', testAuditHmacKey())
        .update(`roadex-device-bridge-identity:v1:roadex:${rawIdentity.toLowerCase()}`)
        .digest('hex');
      expect(created.binding.deviceIdentityTag).toMatch(/^[a-f0-9]{64}$/);
      expect(created.binding.deviceIdentityTag).toBe(expectedIdentityTag);
      expect(created.binding.deviceIdentityTag).not.toBe(auditKeyTag);
      expect(state.deviceInventoryBindings.get(created.binding.id)?.deviceMacTag).toBe(createHmac('sha256', testIdentityHmacKey())
        .update('roadex-device-mac:v1:roadex:aa:bb:cc:dd:ee:ff')
        .digest('hex'));
      expect('deviceMacTag' in created.binding).toBe(false);
      expect(JSON.stringify(created.binding)).not.toContain('AA:BB');
      expect(JSON.stringify(created.binding)).not.toContain('USB-SERIAL-123');
      expect(listDeviceInventoryBindings(state, admin, 'roadex')).toEqual([created.binding]);
      expect(createDeviceInventoryBinding(state, admin, validInventoryBindingPayload(rawIdentity))).toMatchObject({
        ok: false,
        classification: 'quota',
      });
      expect(state.deviceBridgeApprovals.size).toBe(0);
      expect(state.deviceBridgeOperations.size).toBe(0);
      const audit = state.audit.events.at(-1);
      expect(audit?.summary).not.toContain('AA:BB');
      expect(audit?.summary).not.toContain('USB-SERIAL-123');

      const revoked = revokeDeviceInventoryBinding(state, admin, created.binding.id);
      expect(revoked).toMatchObject({ ok: true, binding: { lifecycle: 'revoked' } });
      expect(listDeviceInventoryBindings(state, admin, 'roadex')).toEqual([]);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
      restoreEnv('ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY', originalIdentityHmac);
    }
  });

  it('fails inventory binding closed without the separate identity HMAC key', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    const originalIdentityHmac = process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    delete process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const admin = protectedGatewayUser();

      expect(createDeviceInventoryBinding(state, admin, validInventoryBindingPayload())).toMatchObject({
        ok: false,
        classification: 'audit',
      });
      expect(listDeviceInventoryBindings(state, admin, 'roadex')).toBeUndefined();
      state.deviceInventoryBindings.set('binding', {
        id: 'binding',
        projectId: 'roadex',
        deviceIdentityTag: 'c'.repeat(64),
        allowedOperation: 'esp32.flash',
        secureBootExpected: 'required',
        flashEncryptionExpected: 'required',
        lifecycle: 'active',
        createdBy: admin.id,
        createdAt: new Date().toISOString(),
      });
      expect(revokeDeviceInventoryBinding(state, admin, 'binding')).toMatchObject({
        ok: false,
        classification: 'audit',
      });
      expect(state.deviceInventoryBindings.get('binding')?.lifecycle).toBe('active');
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
      restoreEnv('ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY', originalIdentityHmac);
    }
  });

  it('rejects malformed inventory binding payloads and rolls back persistence failures', async () => {
    const originalRegistry = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    const originalIdentityHmac = process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
    const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;
    const fixture = createArtifactFixture('server-produced-firmware-v1');
    process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = testIdentityHmacKey();
    process.env.ROADEX_WORKSPACES_JSON = workspaceEnv(fixture.root);
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const admin = protectedGatewayUser();
      for (const payload of [
        { ...validInventoryBindingPayload(), extra: true },
        { ...validInventoryBindingPayload(), projectId: '../roadex' },
        { ...validInventoryBindingPayload(), normalizedDeviceIdentity: 'bad/id' },
        { ...validInventoryBindingPayload(), allowedOperation: 'esp32.erase' },
        { ...validInventoryBindingPayload(), secureBootExpected: true },
        { ...validInventoryBindingPayload(), flashEncryptionExpected: 1 },
      ]) {
        expect(createDeviceInventoryBinding(state, admin, payload)).toMatchObject({ ok: false });
      }
      expect(state.deviceInventoryBindings.size).toBe(0);

      const response = await createSessionFromApi(state, admin, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const auditCount = state.audit.events.length;
      state.persistence = failingSavePersistence();
      expect(() =>
        registerDeviceArtifactMetadata(state, admin, response.session.id, validArtifactMetadataPayload()),
      ).toThrow('injected persistence failure');
      expect(() =>
        createDeviceInventoryBinding(state, admin, validInventoryBindingPayload('chip=ESP32 mac=11:22:33:44:55:66')),
      ).toThrow('injected persistence failure');
      expect(state.deviceArtifacts.size).toBe(0);
      expect(state.deviceInventoryBindings.size).toBe(0);
      expect(state.audit.events).toHaveLength(auditCount);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', originalRegistry);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
      restoreEnv('ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY', originalIdentityHmac);
      restoreEnv('ROADEX_WORKSPACES_JSON', originalWorkspaces);
    }
  });

  it('requires protected gateway identity and an exact device bridge request schema', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;

      expect(requestDeviceBridgeIntake(state, mockUser, response.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge request denied.',
        classification: 'auth',
      });
      expect(requestDeviceBridgeIntake(
        state,
        protectedGatewayUser(),
        response.session.id,
        { ...validDeviceBridgeRequest(), extra: true },
      )).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge request denied.',
        classification: 'schema',
      });
      expect(requestDeviceBridgeIntake(
        state,
        protectedGatewayUser(),
        response.session.id,
        { ...validDeviceBridgeRequest(), expectedDeviceId: 'esp32:device' },
      )).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge request denied.',
        classification: 'schema',
      });
      expect(requestDeviceBridgeIntake(
        state,
        protectedGatewayUser(),
        response.session.id,
        { ...validDeviceBridgeRequest(), artifactSha256: 'not-a-digest' },
      )).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge request denied.',
        classification: 'schema',
      });
      expect(state.deviceBridgeRequests.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('validates ownership, workspace, artifact binding, and inventory before pending intake', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      seedDeviceArtifact(state, response.session.id);
      const binding = seedDeviceInventoryBinding(state);

      expect(requestDeviceBridgeIntake(
        state,
        { ...user, id: 'other-user' },
        response.session.id,
        validDeviceBridgeRequest(),
      )).toMatchObject({ ok: false, gate: 'device-bridge', classification: 'session' });
      expect(requestDeviceBridgeIntake(
        state,
        user,
        response.session.id,
        { ...validDeviceBridgeRequest(), workspaceId: 'missing' },
      )).toMatchObject({ ok: false, gate: 'device-bridge', classification: 'workspace' });
      expect(requestDeviceBridgeIntake(
        state,
        user,
        response.session.id,
        { ...validDeviceBridgeRequest(), artifactSha256: 'b'.repeat(64) },
      )).toMatchObject({ ok: false, gate: 'device-bridge', classification: 'artifact' });

      state.deviceInventoryBindings.delete(binding.id);
      expect(requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'inventory',
      });
      seedDeviceInventoryBinding(state, binding.id, 'other-project');
      expect(requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'inventory',
      });
      seedDeviceInventoryBinding(state, binding.id, 'roadex', { lifecycle: 'revoked', revokedAt: new Date().toISOString() });
      expect(requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'inventory',
      });
      seedDeviceInventoryBinding(state, binding.id, 'roadex', { allowedOperation: 'esp8266.flash' as 'esp32.flash' });
      expect(requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'inventory',
      });
      expect(state.deviceBridgeRequests.size).toBe(0);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('fails closed without the dedicated bridge audit HMAC key when intake is enabled', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    delete process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const auditCount = state.audit.events.length;

      expect(requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        reason: 'Device bridge request denied.',
        classification: 'audit',
      });
      expect(state.deviceBridgeRequests.size).toBe(0);
      expect(state.audit.events).toHaveLength(auditCount);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('enforces pending device bridge request limits before mutating state', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const first = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      seedDeviceArtifact(state, first.session.id);
      seedDeviceInventoryBinding(state);

      for (let index = 0; index < 3; index += 1) {
        const result = requestDeviceBridgeIntake(state, user, first.session.id, validDeviceBridgeRequest());
        expect(result.ok).toBe(true);
      }
      expect(requestDeviceBridgeIntake(state, user, first.session.id, validDeviceBridgeRequest())).toMatchObject({
        ok: false,
        gate: 'device-bridge',
        classification: 'quota',
      });
      expect([...state.deviceBridgeRequests.values()].filter((request) =>
        request.sessionId === first.session.id && request.status === 'pending',
      )).toHaveLength(3);

      const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;
      process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
        { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
        { id: 'gateway', name: 'Gateway', root: '/home/god/Documents/Codex Workspace/Protected Service Gateway' },
      ]);
      try {
        const second = await createSessionFromApi(state, user, { workspaceId: 'gateway' });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        seedDeviceArtifact(state, second.session.id, 'gateway');
        seedDeviceInventoryBinding(state, 'gateway-binding', 'gateway', { deviceIdentityTag: 'd'.repeat(64) });
        for (let index = 0; index < 2; index += 1) {
          const result = requestDeviceBridgeIntake(
            state,
            user,
            second.session.id,
            { ...validDeviceBridgeRequest(), workspaceId: 'gateway', inventoryBindingId: 'gateway-binding' },
          );
          expect(result.ok).toBe(true);
        }
        expect(requestDeviceBridgeIntake(
          state,
          user,
          second.session.id,
          { ...validDeviceBridgeRequest(), workspaceId: 'gateway', inventoryBindingId: 'gateway-binding' },
        )).toMatchObject({
          ok: false,
          gate: 'device-bridge',
          classification: 'quota',
        });
        expect([...state.deviceBridgeRequests.values()].filter((request) =>
          request.userId === user.id && request.status === 'pending',
        )).toHaveLength(5);
      } finally {
        restoreEnv('ROADEX_WORKSPACES_JSON', originalWorkspaces);
      }
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('does not count expired pending device bridge requests against session or principal quotas', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      seedDeviceArtifact(state, response.session.id);
      seedDeviceInventoryBinding(state);
      const expiredAt = new Date(Date.now() - 1_000).toISOString();
      for (let index = 0; index < 5; index += 1) {
        const request = expiredBridgeRequest({
          id: `expired-${index}`,
          userId: user.id,
          sessionId: index < 3 ? response.session.id : `other-session-${index}`,
          projectId: 'roadex',
          expiresAt: expiredAt,
        });
        state.deviceBridgeRequests.set(request.id, request);
      }

      const intake = requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest());

      expect(intake).toMatchObject({
        ok: true,
        request: {
          status: 'pending',
          sessionId: response.session.id,
          userId: user.id,
        },
      });
      expect([...state.deviceBridgeRequests.values()].filter((request) =>
        request.userId === user.id && request.status === 'pending',
      )).toHaveLength(6);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('rolls back pending request and audit mutation when intake persistence fails', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      seedDeviceArtifact(state, response.session.id);
      seedDeviceInventoryBinding(state);
      const auditCount = state.audit.events.length;
      state.persistence = failingSavePersistence();

      expect(() => requestDeviceBridgeIntake(state, user, response.session.id, validDeviceBridgeRequest())).toThrow(
        'injected persistence failure',
      );
      expect(state.deviceBridgeRequests.size).toBe(0);
      expect(state.audit.events).toHaveLength(auditCount);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('rolls back denied-intake audit mutation when persistence fails', async () => {
    const originalIntake = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    const originalHmac = process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY;
    process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
    process.env.ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY = testAuditHmacKey();
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const user = protectedGatewayUser();
      const response = await createSessionFromApi(state, user, { workspaceId: 'roadex' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const auditCount = state.audit.events.length;
      state.persistence = failingSavePersistence();

      expect(() => requestDeviceBridgeIntake(
        state,
        user,
        response.session.id,
        { ...validDeviceBridgeRequest(), extra: true },
      )).toThrow('injected persistence failure');
      expect(state.deviceBridgeRequests.size).toBe(0);
      expect(state.audit.events).toHaveLength(auditCount);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', originalIntake);
      restoreEnv('ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY', originalHmac);
    }
  });

  it('submits prompts to the real runner abstraction and streams only for the owning user', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const promptResult = submitPrompt(state, mockUser, response.session.id, 'hello roadex');
    expect(promptResult).toMatchObject({ accepted: true });
    await flushRunner();

    const events = streamEventsForSession(state, mockUser, response.session.id);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'user', message: 'hello roadex' }));
    expect(events?.map((event) => event.kind)).toContain('assistant');
    expect(events?.some((event) => event.message.includes('hello roadex'))).toBe(true);

    const intruder = { ...mockUser, id: 'other-user' };
    expect(streamEventsForSession(state, intruder, response.session.id)).toBeUndefined();
  });

  it('publishes runner events to live subscribers for the owning session', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const received: string[] = [];
    const subscription = subscribeToSessionStream(state, mockUser, response.session.id, (event) => {
      received.push(event.message);
    });

    expect(subscription?.snapshot.length).toBeGreaterThan(0);
    expect(submitPrompt(state, mockUser, response.session.id, 'live please')).toMatchObject({ accepted: true });
    await flushRunner();

    subscription?.unsubscribe();
    expect(received.some((message) => message.includes('live please'))).toBe(true);
  });

  it('stops publishing live events after unsubscribe', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const received: string[] = [];
    const subscription = subscribeToSessionStream(state, mockUser, response.session.id, (event) => {
      received.push(event.message);
    });
    subscription?.unsubscribe();

    submitPrompt(state, mockUser, response.session.id, 'after unsubscribe');
    await flushRunner();

    expect(received.some((message) => message.includes('after unsubscribe'))).toBe(false);
  });

  it('limits live subscribers per session and audits rejected connections', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxStreamSubscribersPerSession = 1;
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const first = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    const rejected = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);

    expect(first).toBeDefined();
    expect(rejected).toBeUndefined();
    expect(state.streamSubscribers.get(response.session.id)?.size).toBe(1);
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: mockUser.id,
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('Live stream subscriber limit reached');

    first?.unsubscribe();
  });

  it('checks stream ownership before reporting subscriber capacity', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxStreamSubscribersPerSession = 1;
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const first = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    const intruder = { ...mockUser, id: 'other-user' };
    const rejected = subscribeToSessionStream(state, intruder, response.session.id, () => undefined);

    expect(rejected).toBeUndefined();
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: intruder.id,
      resource: response.session.id,
    });
    expect(state.audit.events.at(-1)?.summary).toBe('SSE stream denied.');
    first?.unsubscribe();
  });

  it('allows a replacement live subscriber after an existing stream unsubscribes', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxStreamSubscribersPerSession = 1;
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const first = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    first?.unsubscribe();
    const replacement = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);

    expect(replacement).toBeDefined();
    expect(state.streamSubscribers.get(response.session.id)?.size).toBe(1);
    replacement?.unsubscribe();
  });

  it('blocks additional prompts after a failed runner while keeping failure events readable', async () => {
    const state = createInitialState(fakeRunner('failed'), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const promptResult = submitPrompt(state, mockUser, response.session.id, 'break safely');
    expect(promptResult).toMatchObject({ accepted: true });
    await flushRunner();

    expect(streamEventsForSession(state, mockUser, response.session.id)?.map((event) => event.message)).toContain(
      'Codex read: break safely',
    );
    expect(response.session.lifecycle).toBe('blocked');
    expect(streamEventsForSession(state, mockUser, response.session.id)?.length).toBeGreaterThan(0);
    expect(submitPrompt(state, mockUser, response.session.id, 'second prompt')).toBeUndefined();
  });

  it('hides blocked sessions from bootstrap and creates a replacement active session after restart', async () => {
    const persistence = createMemoryPersistence();
    const runner = fakeRunner('failed');
    const state = createInitialState(runner, persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'fail and replace');
    await flushRunner();

    const reloaded = createInitialState(runner, persistence);
    const bootstrapped = await bootstrap(reloaded, mockUser);

    expect(bootstrapped.sessions).toHaveLength(1);
    expect(bootstrapped.sessions[0].id).not.toBe(response.session.id);
    expect(bootstrapped.sessions[0].lifecycle).toBe('ready');
  });

  it('loads persisted sessions, stream events, and audit events after service restart', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(fakeRunner(), persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'persist me');
    await flushRunner();
    const reloaded = createInitialState(fakeRunner(), persistence);
    const bootstrapped = await bootstrap(reloaded, mockUser);

    expect(bootstrapped.sessions).toHaveLength(1);
    expect(bootstrapped.sessions[0]).toMatchObject({
      id: response.session.id,
      workspace: {
        id: 'roadex',
      },
    });
    expect(bootstrapped.streamPreview.some((event) => event.message.includes('persist me'))).toBe(true);
    expect(bootstrapped.auditEvents.some((event) => event.action === 'session.prompt')).toBe(true);
  });

  it('returns only the authenticated user audit events from bootstrap', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const regularUser = { ...mockUser, id: 'regular-user', roles: ['user'] as UserProfile['roles'] };
    const otherUser = { ...mockUser, id: 'other-user', displayName: 'Other user', roles: ['user'] as UserProfile['roles'] };

    await createSessionFromApi(state, regularUser, { workspaceId: 'roadex' });
    await createSessionFromApi(state, otherUser, { workspaceId: 'roadex' });

    const bootstrapped = await bootstrap(state, regularUser);

    expect(bootstrapped.auditEvents.length).toBeGreaterThan(0);
    expect(bootstrapped.auditEvents.every((event) => event.actorId === regularUser.id)).toBe(true);
    const visibleSessionIds = new Set(bootstrapped.sessions.map((session) => session.id));
    expect(bootstrapped.streamPreview.every((event) => visibleSessionIds.has(event.sessionId))).toBe(true);
  });

  it('allows security reviewers to inspect the global audit tail', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const regularUser = { ...mockUser, id: 'regular-user', roles: ['user'] as UserProfile['roles'] };

    await createSessionFromApi(state, regularUser, { workspaceId: 'roadex' });
    const bootstrapped = await bootstrap(state, mockUser);

    expect(bootstrapped.auditEvents.some((event) => event.actorId === regularUser.id)).toBe(true);
  });

  it('persists Codex thread ids so later prompts can resume the same thread after restart', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(fakeRunner('ok', 'thread-roadex-1'), persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'remember this thread');
    await flushRunner();

    expect(response.session.codexThreadId).toBe('thread-roadex-1');

    const reloaded = createInitialState(fakeRunner(), persistence);
    const bootstrapped = await bootstrap(reloaded, mockUser);

    expect(bootstrapped.sessions[0]).toMatchObject({
      id: response.session.id,
      codexThreadId: 'thread-roadex-1',
    });
  });

  it('passes the stored Codex thread id into later prompts for continuity', async () => {
    const observedThreads: Array<string | undefined> = [];
    const state = createInitialState(threadRecordingRunner(observedThreads), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'first');
    await flushRunner();
    submitPrompt(state, mockUser, response.session.id, 'second');
    await flushRunner();

    expect(observedThreads).toEqual([undefined, 'thread-1']);
    expect(response.session.codexThreadId).toBe('thread-2');
  });

  it('attaches only registered managed Codex threads for security reviewers', async () => {
    const originalRegistry = process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
    const originalAuthorizedUsers = process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
    const registry = join(mkdtempSync(join(tmpdir(), 'roadex-managed-')), 'codex-projects.csv');
    const managedThreadId = '019f7337-df2e-75c1-b245-5e3588a6c5aa';
    writeFileSync(
      registry,
      `conversation_id,label,project,created_at,updated_at\n${managedThreadId},Managed thread,"${process.cwd()}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z\n`,
    );
    process.env.ROADEX_CODEX_PROJECTS_REGISTRY = registry;
    process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = `${mockUser.id},other-reviewer`;
    try {
      const persistence = createMemoryPersistence();
      const state = createInitialState(controllableRunner(), persistence);
      const initial = await bootstrap(state, mockUser);
      const managed = initial.managedThreads.find((thread) => thread.id === managedThreadId);
      expect(managed).toBeDefined();
      if (!managed) return;

      state.maxActiveSessionsPerUser = 0;
      const attached = await createSessionFromApi(state, mockUser, {
        workspaceId: managed.project.id,
        managedThreadId,
      });
      expect(attached).toMatchObject({
        ok: true,
        session: {
          codexThreadId: managedThreadId,
          managedThreadId,
          workspace: { id: managed.project.id },
        },
      });
      if (!attached.ok) return;

      const otherReviewer = { ...mockUser, id: 'other-reviewer' };
      expect(await createSessionFromApi(state, otherReviewer, {
        workspaceId: managed.project.id,
        managedThreadId,
      })).toMatchObject({ ok: false, gate: 'managed-thread' });

      const ordinaryUser = { ...mockUser, roles: ['user'] as UserProfile['roles'] };
      expect(await createSessionFromApi(state, ordinaryUser, {
        workspaceId: managed.project.id,
        managedThreadId,
      })).toMatchObject({ ok: false, gate: 'managed-thread' });

      const subscription = subscribeToSessionStream(state, mockUser, attached.session.id, () => undefined);
      expect(subscription).toBeDefined();
      expect(submitPrompt(state, mockUser, attached.session.id, 'in-flight before revocation')).toMatchObject({
        accepted: true,
      });
      process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = 'other-reviewer';
      expect(subscription?.isAuthorized()).toBe(false);
      expect(state.streamSubscribers.has(attached.session.id)).toBe(false);
      await flushRunner();
      expect(state.activeRuns.has(attached.session.id)).toBe(false);
      expect((await bootstrap(state, mockUser)).managedThreads).toEqual([]);
      expect(streamEventsForSession(state, mockUser, attached.session.id)).toBeUndefined();
      expect(submitPrompt(state, mockUser, attached.session.id, 'denied after revocation')).toBeUndefined();

      process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = `${mockUser.id},other-reviewer`;
      const reloaded = createInitialState(fakeRunner(), persistence);
      reloaded.sessions.sessions = [];
      expect(await createSessionFromApi(reloaded, otherReviewer, {
        workspaceId: managed.project.id,
        managedThreadId,
      })).toMatchObject({ ok: false, gate: 'managed-thread' });

      state.runner = fakeRunner('ok', '019f7337-df2e-75c1-b245-5e3588a6c5ff');
      attached.session.lifecycle = 'ready';
      expect(submitPrompt(state, mockUser, attached.session.id, 'mismatched managed identity')).toMatchObject({
        accepted: true,
      });
      await flushRunner();
      expect(attached.session).toMatchObject({
        lifecycle: 'blocked',
        codexThreadId: managedThreadId,
        managedThreadId,
      });
    } finally {
      if (originalRegistry === undefined) delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
      else process.env.ROADEX_CODEX_PROJECTS_REGISTRY = originalRegistry;
      if (originalAuthorizedUsers === undefined) delete process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
      else process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = originalAuthorizedUsers;
    }
  });

  it('supports multiple server-approved workspaces by id only', async () => {
    const original = process.env.ROADEX_WORKSPACES_JSON;
    const originalRegistry = process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
    process.env.ROADEX_CODEX_PROJECTS_REGISTRY = '/nonexistent/test-codex-projects.csv';
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
      { id: 'gateway', name: 'Protected Gateway', root: '/home/god/Documents/Codex Workspace/Protected Service Gateway' },
    ]);
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const defaultBootstrap = await bootstrap(state, mockUser);
      const response = await createSessionFromApi(state, mockUser, { workspaceId: 'gateway' });
      const nextBootstrap = await bootstrap(state, mockUser);

      expect(defaultBootstrap.workspaces.map((workspace) => workspace.id)).toEqual(['roadex', 'gateway']);
      expect(response).toMatchObject({
        ok: true,
        session: {
          workspace: {
            id: 'gateway',
            root: '/home/god/Documents/Codex Workspace/Protected Service Gateway',
          },
        },
      });
      expect(nextBootstrap.sessions.map((session) => session.workspace.id)).toEqual(['roadex', 'gateway']);
    } finally {
      if (original === undefined) {
        delete process.env.ROADEX_WORKSPACES_JSON;
      } else {
        process.env.ROADEX_WORKSPACES_JSON = original;
      }
      if (originalRegistry === undefined) delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
      else process.env.ROADEX_CODEX_PROJECTS_REGISTRY = originalRegistry;
    }
  });

  it('cancels an active runner and returns the session to ready', async () => {
    const state = createInitialState(controllableRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'long run');
    await flushRunner();

    expect(response.session.lifecycle).toBe('streaming');
    expect(cancelSessionRun(state, mockUser, response.session.id)).toMatchObject({ cancelled: true });
    await flushRunner();

    expect(response.session.lifecycle).toBe('ready');
    expect(streamEventsForSession(state, mockUser, response.session.id)?.some((event) => event.message.includes('cancel'))).toBe(
      true,
    );
  });

  it('returns a not-running cancel result for an owned inactive session', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const cancel = cancelSessionRun(state, mockUser, response.session.id);

    expect(cancel).toMatchObject({
      cancelled: false,
      status: 'not-running',
      auditEvent: {
        action: 'session.cancel',
        outcome: 'denied',
      },
    });
    expect(cancel?.auditEvent.summary).toContain('active_runner=false');
  });

  it('archives an owned session and removes it from active bootstrap results', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const subscription = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    expect(subscription).toBeDefined();
    const close = closeSession(state, mockUser, response.session.id);
    const bootstrapped = await bootstrap(state, mockUser);

    expect(close).toMatchObject({
      closed: true,
      auditEvent: {
        action: 'session.close',
        outcome: 'allowed',
      },
    });
    expect(response.session.lifecycle).toBe('closed');
    expect(state.streamSubscribers.has(response.session.id)).toBe(false);
    expect(bootstrapped.sessions.some((session) => session.id === response.session.id)).toBe(false);
    expect(bootstrapped.sessions).toEqual([]);
    expect(listArchivedSessions(state, mockUser)).toEqual([response.session]);
  });

  it('denies wrong-owner session archive attempts', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const intruder = { ...mockUser, id: 'other-user' };
    expect(closeSession(state, intruder, response.session.id)).toBeUndefined();
    expect(response.session.lifecycle).toBe('ready');
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: 'other-user',
      resource: response.session.id,
      outcome: 'denied',
    });
  });

  it('lists only archived sessions owned by the authenticated user', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const otherUser = { ...mockUser, id: 'other-user' };
    const owned = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
    const other = await createSessionFromApi(state, otherUser, { workspaceId: 'roadex' });

    expect(owned.ok).toBe(true);
    expect(other.ok).toBe(true);
    if (!owned.ok || !other.ok) return;

    closeSession(state, mockUser, owned.session.id);
    closeSession(state, otherUser, other.session.id);

    expect(listArchivedSessions(state, mockUser)).toEqual([owned.session]);
  });

  it('reopens an owned archived session with its Codex thread and transcript intact', async () => {
    const state = createInitialState(fakeRunner('ok', 'thread-roadex-reopen'), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'preserve this history');
    await flushRunner();
    closeSession(state, mockUser, response.session.id);

    const reopened = reopenSession(state, mockUser, response.session.id);

    expect(reopened).toMatchObject({
      reopened: true,
      session: {
        id: response.session.id,
        lifecycle: 'ready',
        codexThreadId: 'thread-roadex-reopen',
      },
      auditEvent: {
        action: 'session.reopen',
        outcome: 'allowed',
      },
    });
    expect(streamEventsForSession(state, mockUser, response.session.id)?.some((event) =>
      event.message.includes('preserve this history'),
    )).toBe(true);
  });

  it('denies reopen attempts for another user without exposing session state', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    closeSession(state, mockUser, response.session.id);

    const intruder = { ...mockUser, id: 'other-user' };
    expect(reopenSession(state, intruder, response.session.id)).toBeUndefined();
    expect(response.session.lifecycle).toBe('closed');
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: intruder.id,
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('session_not_owned_or_missing');
  });

  it('denies reopening a session unless it is closed and has no active runner', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    expect(reopenSession(state, mockUser, response.session.id)).toBeUndefined();
    expect(state.audit.events.at(-1)?.summary).toContain('session_not_closed');

    closeSession(state, mockUser, response.session.id);
    state.activeRuns.set(response.session.id, new AbortController());
    expect(reopenSession(state, mockUser, response.session.id)).toBeUndefined();
    expect(response.session.lifecycle).toBe('closed');
    expect(state.audit.events.at(-1)?.summary).toContain('active_runner_present');
  });

  it('denies reopening when the archived workspace is no longer approved', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    closeSession(state, mockUser, response.session.id);

    const original = process.env.ROADEX_WORKSPACES_JSON;
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'gateway', name: 'Gateway', root: '/srv/gateway' },
    ]);
    try {
      expect(reopenSession(state, mockUser, response.session.id)).toBeUndefined();
      expect(response.session.lifecycle).toBe('closed');
      expect(state.audit.events.at(-1)?.summary).toContain('workspace_no_longer_approved');
    } finally {
      if (original === undefined) delete process.env.ROADEX_WORKSPACES_JSON;
      else process.env.ROADEX_WORKSPACES_JSON = original;
    }
  });

  it('reopens an owned thread when the workspace already has another active thread', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const archived = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    closeSession(state, mockUser, archived.session.id);
    const active = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
    expect(active.ok).toBe(true);

    expect(reopenSession(state, mockUser, archived.session.id)).toMatchObject({
      reopened: true,
      session: { id: archived.session.id, lifecycle: 'ready' },
    });
    expect(active.ok).toBe(true);
  });

  it('creates a new owned thread only when explicitly requested', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const first = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
    const reused = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
    const second = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex', newThread: true });

    expect(first.ok).toBe(true);
    expect(reused.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !reused.ok || !second.ok) return;

    expect(reused.session.id).toBe(first.session.id);
    expect(second.session.id).not.toBe(first.session.id);
    expect(state.sessions.sessions.filter((candidate) => candidate.lifecycle !== 'closed')).toHaveLength(2);
  });

  it('limits explicit active thread creation per user', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxActiveSessionsPerUser = 1;
    const first = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
    const denied = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex', newThread: true });

    expect(first.ok).toBe(true);
    expect(denied).toMatchObject({ ok: false, gate: 'session-limit' });
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      resource: 'session-limit',
      outcome: 'denied',
    });
  });

  it('applies the active thread limit when opening another project', async () => {
    const original = process.env.ROADEX_WORKSPACES_JSON;
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
      { id: 'gateway', name: 'Gateway', root: '/srv/gateway' },
    ]);
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      state.maxActiveSessionsPerUser = 1;
      expect((await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' })).ok).toBe(true);
      expect(await createSessionFromApi(state, mockUser, { workspaceId: 'gateway' })).toMatchObject({
        ok: false,
        gate: 'session-limit',
      });
    } finally {
      if (original === undefined) delete process.env.ROADEX_WORKSPACES_JSON;
      else process.env.ROADEX_WORKSPACES_JSON = original;
    }
  });

  it('applies the active thread limit when reopening an archived thread', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const archived = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    closeSession(state, mockUser, archived.session.id);
    expect((await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' })).ok).toBe(true);
    state.maxActiveSessionsPerUser = 1;

    expect(reopenSession(state, mockUser, archived.session.id)).toMatchObject({
      reopened: false,
      gate: 'session-limit',
    });
    expect(archived.session.lifecycle).toBe('closed');
    expect(state.audit.events.at(-1)?.summary).toContain('active_session_limit_reached');
  });

  it('denies wrong-owner cancellation and records actor/session detail', async () => {
    const state = createInitialState(controllableRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'long run');
    await flushRunner();

    const intruder = { ...mockUser, id: 'other-user' };
    expect(cancelSessionRun(state, intruder, response.session.id)).toBeUndefined();
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: 'other-user',
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('session_not_owned_or_missing');
  });

  it('adds an alert-style audit event for repeated inactive cancel attempts', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    cancelSessionRun(state, mockUser, response.session.id);
    cancelSessionRun(state, mockUser, response.session.id);
    cancelSessionRun(state, mockUser, response.session.id);

    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('Cancel alert');
    expect(state.audit.events.at(-1)?.summary).toContain('attempts=3');
  });

  it('enforces the active runner concurrency limit', async () => {
    const original = process.env.ROADEX_WORKSPACES_JSON;
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
      { id: 'gateway', name: 'Gateway', root: '/home/god/Documents/Codex Workspace/Protected Service Gateway' },
    ]);
    try {
      const state = createInitialState(controllableRunner(), createMemoryPersistence());
      state.maxActiveRuns = 1;
      const first = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
      const second = await createSessionFromApi(state, mockUser, { workspaceId: 'gateway' });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(submitPrompt(state, mockUser, first.session.id, 'first')).toMatchObject({ accepted: true });
      await flushRunner();
      expect(submitPrompt(state, mockUser, second.session.id, 'second')).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.ROADEX_WORKSPACES_JSON;
      } else {
        process.env.ROADEX_WORKSPACES_JSON = original;
      }
    }
  });
});

async function flushRunner(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function protectedGatewayUser(): UserProfile {
  return {
    ...mockUser,
    authMode: 'protected-gateway',
  };
}

function validDeviceBridgeRequest() {
  return {
    workspaceId: 'roadex',
    artifactId: 'artifact',
    artifactSha256: 'a'.repeat(64),
    inventoryBindingId: 'binding',
    operation: 'esp32.flash',
  };
}

function validArtifactMetadataPayload() {
  return {
    artifactPath: 'build/firmware.bin',
    label: 'firmware.bin',
  };
}

function createArtifactFixture(contents: string) {
  const root = mkdtempSync(join(tmpdir(), 'roadex-artifacts-'));
  const artifactPath = 'build/firmware.bin';
  writeProjectArtifact(root, artifactPath, contents);
  return {
    root,
    artifactPath,
    byteLength: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function writeProjectArtifact(root: string, artifactPath: string, contents: string): void {
  const absolutePath = join(root, artifactPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function workspaceEnv(root: string): string {
  return JSON.stringify([{ id: 'roadex', name: 'Roadex Portal', root }]);
}

function testIdentityHmacKey(): string {
  return 'test-device-bridge-identity-hmac-key-32';
}

function validInventoryBindingPayload(normalizedDeviceIdentity = 'chip=ESP32 mac=AA:BB:CC:DD:EE:FF') {
  return {
    projectId: 'roadex',
    normalizedDeviceIdentity,
    allowedOperation: 'esp32.flash',
    secureBootExpected: 'required',
    flashEncryptionExpected: 'required',
  };
}

function seedDeviceArtifact(
  state: ReturnType<typeof createInitialState>,
  sessionId: string,
  projectId = 'roadex',
): DeviceArtifactMetadata {
  const artifact: DeviceArtifactMetadata = {
    id: 'artifact',
    projectId,
    sessionId,
    producerUserId: mockUser.id,
    producerThreadId: 'thread-artifact',
    label: 'firmware.bin',
    byteLength: 1024,
    mediaType: 'application/octet-stream',
    format: 'esp32-firmware-bin',
    sha256: 'a'.repeat(64),
    storageReference: 'artifact-ref-test',
    status: 'active',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  state.deviceArtifacts.set(artifact.id, artifact);
  return artifact;
}

function seedDeviceInventoryBinding(
  state: ReturnType<typeof createInitialState>,
  id = 'binding',
  projectId = 'roadex',
  overrides: Partial<DeviceInventoryBindingRecord> = {},
): DeviceInventoryBindingRecord {
  const binding: DeviceInventoryBindingRecord = {
    id,
    projectId,
    deviceIdentityTag: 'c'.repeat(64),
    allowedOperation: 'esp32.flash',
    secureBootExpected: 'required',
    flashEncryptionExpected: 'required',
    lifecycle: 'active',
    createdBy: protectedGatewayUser().id,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  state.deviceInventoryBindings.set(id, binding);
  return binding;
}

function expiredBridgeRequest(
  overrides: Pick<DeviceBridgeRequestRecord, 'id' | 'userId' | 'sessionId' | 'projectId' | 'expiresAt'>,
): DeviceBridgeRequestRecord {
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  return {
    id: overrides.id,
    userId: overrides.userId,
    sessionId: overrides.sessionId,
    projectId: overrides.projectId,
    artifactId: 'artifact',
    artifactSha256: 'a'.repeat(64),
    inventoryBindingId: 'binding',
    deviceIdentityTag: 'c'.repeat(64),
    operation: 'esp32.flash',
    status: 'pending',
    createdAt,
    expiresAt: overrides.expiresAt,
  };
}

function testAuditHmacKey(): string {
  return 'test-device-bridge-audit-hmac-key-32';
}

function failingSavePersistence(): StatePersistence {
  return {
    load() {
      return {
        sessions: [],
        streamEvents: [],
        auditEvents: [],
        managedThreadClaims: [],
        deviceArtifacts: [],
        deviceBridgeRequests: [],
        deviceBridgeApprovals: [],
        deviceBridgeOperations: [],
        deviceInventoryBindings: [],
      };
    },
    save() {
      throw new Error('injected persistence failure');
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
