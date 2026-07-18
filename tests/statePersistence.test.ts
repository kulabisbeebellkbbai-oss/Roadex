import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonFilePersistence, serializeState } from '../src/server/statePersistence';
import type { RoadexSession, StreamEvent } from '../src/shared/sessionContracts';
import type {
  DeviceArtifactMetadata,
  DeviceBridgeOperationRecord,
  DeviceInventoryBindingRecord,
} from '../src/shared/deviceBridgeContracts';

describe('state persistence', () => {
  it('writes Roadex runtime state as mode 600 JSON and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-'));
    const path = join(dir, 'state.json');
    const persistence = createJsonFilePersistence(path);
    const session = sessionFixture('session-1', 'ready', new Date(0).toISOString());

    persistence.save({
      sessions: [session],
      streamEvents: [
        {
          id: 'event-1',
          sessionId: 'session-1',
          kind: 'system',
          message: 'persisted',
          at: new Date(0).toISOString(),
        },
      ],
      auditEvents: [],
      managedThreadClaims: [],
      deviceArtifacts: [],
      deviceBridgeRequests: [],
      deviceBridgeApprovals: [],
      deviceBridgeOperations: [],
      deviceInventoryBindings: [],
    });

    expect(readFileSync(path, 'utf8')).toContain('persisted');
    expect(persistence.load().streamEvents).toHaveLength(1);
  });

  it('trims stale closed sessions and their transcript events during serialization', () => {
    const now = Date.UTC(2026, 6, 17);
    const fresh = sessionFixture('fresh', 'ready', new Date(now).toISOString());
    const archived = sessionFixture('archived', 'closed', new Date(now - 1_000).toISOString());
    const stale = sessionFixture('stale', 'closed', new Date(now - 10_000).toISOString());
    const state = serializeState(
      {
        sessions: [stale, archived, fresh],
        streamEvents: [
          streamEvent('stale-event', stale.id),
          streamEvent('archived-event', archived.id),
          streamEvent('fresh-event', fresh.id),
        ],
        auditEvents: [],
      },
      {
        now,
        sessionRetentionMs: 5_000,
        maxSessions: 5,
        maxStreamEvents: 5,
        maxAuditEvents: 5,
      },
    );

    expect(state.sessions.map((session) => session.id)).toEqual(['archived', 'fresh']);
    expect(state.streamEvents.map((event) => event.id)).toEqual(['archived-event', 'fresh-event']);
  });

  it('caps retained sessions, transcript events, and audit events', () => {
    const now = Date.UTC(2026, 6, 17);
    const sessions = ['one', 'two', 'three'].map((id, index) =>
      sessionFixture(id, 'closed', new Date(now + index).toISOString()),
    );
    const state = serializeState(
      {
        sessions,
        streamEvents: [
          streamEvent('event-one', 'one'),
          streamEvent('event-two', 'two'),
          streamEvent('event-three', 'three'),
        ],
        auditEvents: [
          {
            id: 'audit-one',
            at: new Date(now).toISOString(),
            actorId: 'user',
            action: 'session.close',
            resource: 'one',
            outcome: 'allowed',
            summary: 'one',
          },
          {
            id: 'audit-two',
            at: new Date(now).toISOString(),
            actorId: 'user',
            action: 'session.close',
            resource: 'two',
            outcome: 'allowed',
            summary: 'two',
          },
        ],
      },
      {
        now,
        maxSessions: 2,
        maxStreamEvents: 1,
        maxAuditEvents: 1,
        sessionRetentionMs: 60_000,
      },
    );

    expect(state.sessions.map((session) => session.id)).toEqual(['two', 'three']);
    expect(state.streamEvents.map((event) => event.id)).toEqual(['event-three']);
    expect(state.auditEvents.map((event) => event.id)).toEqual(['audit-two']);
  });

  it('retains managed thread claims after their Roadex sessions expire', () => {
    const now = Date.UTC(2026, 6, 17);
    const stale = {
      ...sessionFixture('stale', 'closed', new Date(now - 10_000).toISOString()),
      managedThreadId: '019f7337-df2e-75c1-b245-5e3588a6c5aa',
    };
    const state = serializeState(
      {
        sessions: [stale],
        managedThreadClaims: [{ threadId: stale.managedThreadId, userId: 'user', claimedAt: stale.createdAt }],
      },
      { now, sessionRetentionMs: 5_000 },
    );

    expect(state.sessions).toEqual([]);
    expect(state.managedThreadClaims).toEqual([
      { threadId: stale.managedThreadId, userId: 'user', claimedAt: stale.createdAt },
    ]);
  });

  it('persists valid bridge metadata and discards malformed records without credentials', () => {
    const now = new Date().toISOString();
    const state = serializeState({
      deviceArtifacts: [{
        id: 'artifact',
        projectId: 'roadex',
        sessionId: 'session',
        producerUserId: 'user',
        producerThreadId: 'thread',
        label: 'firmware.bin',
        byteLength: 1024,
        mediaType: 'application/octet-stream',
        format: 'esp32-firmware-bin',
        sha256: 'a'.repeat(64),
        storageReference: 'artifact-ref-test',
        status: 'active',
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
        credential: 'must-be-stripped',
        firmwareBytes: 'must-be-stripped',
      } as DeviceArtifactMetadata, {
        id: 'bad-artifact',
        projectId: 'roadex',
        sessionId: 'session',
        producerUserId: 'user',
        label: 'bad.bin',
        byteLength: -1,
        mediaType: 'application/octet-stream',
        format: 'esp32-firmware-bin',
        sha256: 'not-a-digest',
        storageReference: 'bad-ref',
        status: 'active',
        createdAt: now,
        expiresAt: now,
      }],
      deviceInventoryBindings: [{
        id: 'binding',
        projectId: 'roadex',
        deviceIdentityTag: 'c'.repeat(64),
        allowedOperation: 'esp32.flash',
        secureBootExpected: 'required',
        flashEncryptionExpected: 'required',
        lifecycle: 'active',
        createdBy: 'admin',
        createdAt: now,
        rawDeviceIdentity: 'must-be-stripped',
      } as DeviceInventoryBindingRecord, {
        id: 'bad-binding',
        projectId: 'roadex',
        deviceIdentityTag: 'raw-usb-serial',
        allowedOperation: 'esp32.flash',
        secureBootExpected: 'required',
        flashEncryptionExpected: 'required',
        lifecycle: 'active',
        createdBy: 'admin',
        createdAt: now,
      } as DeviceInventoryBindingRecord],
      deviceBridgeApprovals: [{
        id: 'approval',
        userId: 'user',
        sessionId: 'session',
        projectId: 'roadex',
        artifactId: 'artifact',
        artifactSha256: 'a'.repeat(64),
        expectedDeviceId: 'inventory-device',
        operation: 'esp32.flash',
        status: 'pending',
        createdAt: now,
        expiresAt: now,
      }],
      deviceBridgeOperations: [{
        id: 'operation',
        approvalId: 'approval',
        userId: 'user',
        sessionId: 'session',
        projectId: 'roadex',
        artifactId: 'artifact',
        artifactSha256: 'a'.repeat(64),
        expectedDeviceId: 'inventory-device',
        operation: 'esp32.flash',
        phase: 'probe',
        credentialDigest: 'b'.repeat(64),
        nextEventSequence: 0,
        phaseExpiresAt: now,
        reportingExpiresAt: now,
        createdAt: now,
        updatedAt: now,
        token: 'must-be-stripped',
        probeOutput: 'must-be-stripped',
      } as DeviceBridgeOperationRecord],
    });

    expect(state.deviceArtifacts.map((record) => record.id)).toEqual(['artifact']);
    expect(state.deviceInventoryBindings.map((record) => record.id)).toEqual(['binding']);
    expect(state.deviceBridgeApprovals.map((record) => record.id)).toEqual(['approval']);
    expect(state.deviceBridgeOperations.map((record) => record.id)).toEqual(['operation']);
    expect(JSON.stringify(state)).not.toContain('must-be-stripped');
    expect('credential' in state.deviceArtifacts[0]).toBe(false);
    expect('token' in state.deviceBridgeOperations[0]).toBe(false);
    expect(JSON.stringify(state)).not.toContain('firmwareBytes');
    expect(JSON.stringify(state)).not.toContain('token');
    expect(JSON.stringify(state)).not.toContain('probeOutput');
    expect(JSON.stringify(state)).not.toContain('raw-usb-serial');
  });

  it('bounds retained bridge records and removes stale unreferenced artifacts', () => {
    const now = Date.UTC(2026, 6, 18);
    const recent = new Date(now).toISOString();
    const stale = new Date(now - 10_000).toISOString();
    const artifact = (id: string, createdAt: string): DeviceArtifactMetadata => ({
      id,
      projectId: 'roadex',
      sessionId: 'session',
      producerUserId: 'user',
      label: `${id}.bin`,
      byteLength: 1,
      mediaType: 'application/octet-stream',
      format: 'esp32-firmware-bin',
      sha256: 'a'.repeat(64),
      storageReference: `${id}-ref`,
      status: 'active',
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
    });
    const state = serializeState(
      { deviceArtifacts: [artifact('stale', stale), artifact('one', recent), artifact('two', recent)] },
      { now, deviceBridgeRetentionMs: 5_000, maxDeviceArtifacts: 1 },
    );

    expect(state.deviceArtifacts).toHaveLength(1);
    expect(state.deviceArtifacts[0].id).not.toBe('stale');
  });

  it('preserves every artifact referenced by retained operations beyond the artifact cap', () => {
    const now = Date.UTC(2026, 6, 18);
    const recent = new Date(now).toISOString();
    const stale = new Date(now - 10_000).toISOString();
    const operation = (id: string, artifactId: string): DeviceBridgeOperationRecord => ({
      id,
      approvalId: `approval-${id}`,
      userId: 'user',
      sessionId: 'session',
      projectId: 'roadex',
      artifactId,
      artifactSha256: 'a'.repeat(64),
      expectedDeviceId: 'inventory-device',
      operation: 'esp32.flash',
      phase: 'probe',
      credentialDigest: 'b'.repeat(64),
      nextEventSequence: 0,
      phaseExpiresAt: recent,
      reportingExpiresAt: recent,
      createdAt: recent,
      updatedAt: recent,
    });
    const artifact = (id: string): DeviceArtifactMetadata => ({
      id,
      projectId: 'roadex',
      sessionId: 'session',
      producerUserId: 'user',
      label: `${id}.bin`,
      byteLength: 1,
      mediaType: 'application/octet-stream',
      format: 'esp32-firmware-bin',
      sha256: 'a'.repeat(64),
      storageReference: `${id}-ref`,
      status: 'active',
      createdAt: stale,
      expiresAt: recent,
    });
    const state = serializeState(
      {
        deviceArtifacts: [artifact('one'), artifact('two')],
        deviceBridgeOperations: [operation('one', 'one'), operation('two', 'two')],
      },
      { now, deviceBridgeRetentionMs: 5_000, maxDeviceArtifacts: 1 },
    );

    expect(state.deviceArtifacts.map((record) => record.id).sort()).toEqual(['one', 'two']);
  });
});

function sessionFixture(id: string, lifecycle: RoadexSession['lifecycle'], updatedAt: string): RoadexSession {
  return {
    id,
    userId: 'user',
    workspace: {
      id: 'roadex',
      name: 'Roadex Portal',
      root: '/srv/roadex',
    },
    lifecycle,
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function streamEvent(id: string, sessionId: string): StreamEvent {
  return {
    id,
    sessionId,
    kind: 'system',
    message: id,
    at: new Date(0).toISOString(),
  };
}
