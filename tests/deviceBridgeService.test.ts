import { describe, expect, it } from 'vitest';
import { createDeviceBridgeService, type DeviceBridgeStore } from '../src/server/deviceBridgeService';
import { mockUser } from '../src/server/authService';
import type { DeviceArtifactMetadata } from '../src/shared/deviceBridgeContracts';
import type { RoadexSession } from '../src/shared/sessionContracts';

describe('disabled device bridge state machine', () => {
  it('is hard-disabled unless tests explicitly inject enablement', () => {
    const store = createStore();
    const service = createDeviceBridgeService(store);

    expect(service.requestApproval(mockUser, session(), 'artifact', 'esp32:device')).toEqual({
      ok: false,
      reason: 'Device bridge operations are disabled.',
    });
    expect(store.approvals.size).toBe(0);
    expect(store.operations.size).toBe(0);
  });

  it('ignores production operation enablement environment and remains hard-disabled', () => {
    const original = process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED;
    process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED = '1';
    try {
      const store = createStore();
      const service = createDeviceBridgeService(store, {
        resolveSession: () => session(),
        resolveInventoryDevice: (_projectId, deviceId) => ({ id: deviceId }),
      });

      expect(service.requestApproval(mockUser, session(), 'artifact', 'esp32:device')).toEqual({
        ok: false,
        reason: 'Device bridge operations are disabled.',
      });
      expect(store.approvals.size).toBe(0);
      expect(store.operations.size).toBe(0);
    } finally {
      if (original === undefined) delete process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED;
      else process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED = original;
    }
  });

  it('consumes approvals once and requires verified probe plus fresh confirmation', () => {
    const store = createStore();
    let id = 0;
    let secret = 0;
    const service = createDeviceBridgeService(store, {
      ...enabledOptions(),
      now: () => Date.UTC(2026, 6, 18),
      createId: () => `id-${++id}`,
      createSecret: () => `secret-${++secret}`,
    });
    const approval = service.requestApproval(mockUser, session(), 'artifact', 'esp32:device');
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    const started = service.startProbe(mockUser, approval.value.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(service.startProbe(mockUser, approval.value.id)).toMatchObject({ ok: false });
    const probe = service.submitProbe(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      'esp32:device',
      'a'.repeat(64),
    );
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(service.authorizeWrite(
      { ...mockUser, id: 'other-user' },
      started.value.operation.id,
      started.value.credential,
      probe.value.challenge,
    )).toMatchObject({ ok: false });
    const authorized = service.authorizeWrite(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      probe.value.challenge,
    );
    expect(authorized.ok).toBe(true);
    expect(service.authorizeWrite(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      probe.value.challenge,
    )).toMatchObject({ ok: false });
    expect(started.value.operation).toMatchObject({
      phase: 'destructive',
      actualDeviceId: 'esp32:device',
      confirmationChallengeDigest: undefined,
    });
    const persistedRecords = JSON.stringify([...store.operations.values()]);
    expect(persistedRecords).not.toContain(started.value.credential);
    expect(persistedRecords).not.toContain(probe.value.challenge);
    service.revokeSession('session');
    expect(started.value.operation.phase).toBe('reporting');
    expect(started.value.operation.destructiveNonceDigest).toBeUndefined();
  });

  it('fails closed on identity mismatch and denies cross-user credentials', () => {
    const store = createStore();
    const service = createDeviceBridgeService(store, {
      ...enabledOptions(),
      createId: () => crypto.randomUUID(),
      createSecret: () => crypto.randomUUID(),
    });
    const approval = service.requestApproval(mockUser, session(), 'artifact', 'esp32:device');
    if (!approval.ok) return;
    const started = service.startProbe(mockUser, approval.value.id);
    if (!started.ok) return;
    const otherUser = { ...mockUser, id: 'other-user' };

    expect(service.submitProbe(
      otherUser,
      started.value.operation.id,
      started.value.credential,
      'esp32:device',
      'a'.repeat(64),
    )).toMatchObject({ ok: false });
    expect(service.submitProbe(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      'esp32:wrong',
      'a'.repeat(64),
    )).toMatchObject({ ok: false });
    expect(started.value.operation.phase).toBe('failed');
  });

  it('rejects expired approvals and revokes pending or active session work', () => {
    const store = createStore();
    let now = Date.UTC(2026, 6, 18);
    const service = createDeviceBridgeService(store, {
      ...enabledOptions(),
      now: () => now,
      createId: () => crypto.randomUUID(),
      createSecret: () => crypto.randomUUID(),
    });
    const expiredApproval = service.requestApproval(mockUser, session(), 'artifact', 'esp32:device');
    if (!expiredApproval.ok) return;
    now += 5 * 60_000;
    expect(service.startProbe(mockUser, expiredApproval.value.id)).toMatchObject({ ok: false });

    now = Date.UTC(2026, 6, 18);
    const approval = service.requestApproval(mockUser, session(), 'artifact', 'esp32:device');
    if (!approval.ok) return;
    const started = service.startProbe(mockUser, approval.value.id);
    if (!started.ok) return;
    service.revokeSession('session');
    expect(started.value.operation.phase).toBe('cancelled');
  });

  it('rechecks current policy, inventory, artifact binding, and challenge expiry at transitions', () => {
    const store = createStore();
    let now = Date.UTC(2026, 6, 18);
    let currentSession = session();
    let inventoryAvailable = true;
    const service = createDeviceBridgeService(store, {
      enabledForTestsOnly: true,
      now: () => now,
      createId: () => crypto.randomUUID(),
      createSecret: () => crypto.randomUUID(),
      resolveSession: () => currentSession,
      resolveInventoryDevice: (_projectId, deviceId) => inventoryAvailable ? { id: deviceId } : undefined,
    });
    const approval = service.requestApproval(mockUser, currentSession, 'artifact', 'esp32:device');
    if (!approval.ok) return;
    currentSession = { ...currentSession, lifecycle: 'closed' };
    expect(service.startProbe(mockUser, approval.value.id)).toMatchObject({ ok: false });

    currentSession = session();
    const replacedApproval = service.requestApproval(mockUser, currentSession, 'artifact', 'esp32:device');
    if (!replacedApproval.ok) return;
    store.artifacts.set('artifact', { ...createArtifact(), sha256: 'b'.repeat(64) });
    expect(service.startProbe(mockUser, replacedApproval.value.id)).toMatchObject({ ok: false });
    store.artifacts.set('artifact', createArtifact());
    const nextApproval = service.requestApproval(mockUser, currentSession, 'artifact', 'esp32:device');
    if (!nextApproval.ok) return;
    const started = service.startProbe(mockUser, nextApproval.value.id);
    if (!started.ok) return;
    const probe = service.submitProbe(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      'esp32:device',
      'a'.repeat(64),
    );
    if (!probe.ok) return;
    inventoryAvailable = false;
    expect(service.authorizeWrite(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      probe.value.challenge,
    )).toMatchObject({ ok: false });

    inventoryAvailable = true;
    store.artifacts.set('artifact', { ...createArtifact(), sha256: 'b'.repeat(64) });
    expect(service.authorizeWrite(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      probe.value.challenge,
    )).toMatchObject({ ok: false });
    store.artifacts.set('artifact', createArtifact());
    now += 60_000;
    expect(service.authorizeWrite(
      mockUser,
      started.value.operation.id,
      started.value.credential,
      probe.value.challenge,
    )).toMatchObject({ ok: false });
  });
});

function createStore(): DeviceBridgeStore {
  const artifact = createArtifact();
  return {
    artifacts: new Map([[artifact.id, artifact]]),
    approvals: new Map(),
    operations: new Map(),
  };
}

function createArtifact(): DeviceArtifactMetadata {
  return {
    id: 'artifact',
    projectId: 'roadex',
    sessionId: 'session',
    label: 'firmware.bin',
    byteLength: 1024,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
  };
}

function session(): RoadexSession {
  const now = new Date().toISOString();
  return {
    id: 'session',
    userId: mockUser.id,
    workspace: { id: 'roadex', name: 'Roadex', root: process.cwd() },
    lifecycle: 'ready',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: now,
    updatedAt: now,
  };
}

function enabledOptions() {
  return {
    enabledForTestsOnly: true,
    resolveSession: () => session(),
    resolveInventoryDevice: (_projectId: string, deviceId: string) =>
      deviceId === 'esp32:device' ? { id: deviceId } : undefined,
  };
}
