import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonFilePersistence, serializeState } from '../src/server/statePersistence';
import type { ApprovalWaitRecord } from '../src/shared/approvalWorkflowContracts';
import type { RoadexSession, StreamEvent } from '../src/shared/sessionContracts';
import type {
  DeviceArtifactMetadata,
  DeviceBridgeOperationRecord,
  DeviceBridgeRequestRecord,
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

  it('recovers only sessions blocked by the removed legacy runner timeout', () => {
    const timedOut = sessionFixture('timed-out', 'blocked', new Date(0).toISOString());
    const failed = sessionFixture('failed', 'blocked', new Date(0).toISOString());
    const state = serializeState(
      {
        sessions: [timedOut, failed],
        streamEvents: [
          { ...streamEvent('timeout', timedOut.id), kind: 'system', message: 'Codex runner timed out and was stopped.' },
          { ...streamEvent('timeout-failed', timedOut.id), kind: 'system', message: 'Codex runner failed.' },
          { ...streamEvent('ordinary-failed', failed.id), kind: 'system', message: 'Codex runner failed.' },
        ],
        auditEvents: [],
      },
      { now: 0, sessionRetentionMs: 1 },
    );

    expect(state.sessions.find((session) => session.id === timedOut.id)?.lifecycle).toBe('ready');
    expect(state.sessions.find((session) => session.id === failed.id)?.lifecycle).toBe('blocked');
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

  it('drops invalid approval waits and preserves an independent streaming session normalization', () => {
    const now = new Date(0).toISOString();
    const session = sessionFixture('streaming-session', 'streaming', now);
    const approvalWaits: Array<ApprovalWaitRecord | (ApprovalWaitRecord & { consolePath: string })> = [
      approvalWaitFixture({
        id: 'valid-wait',
        sessionId: session.id,
        consoleSurface: 'admin',
        authorityClass: 'privileged-operation',
        subject: 'Reconcile change approval',
        approvalRef: 'approval-valid',
        continuationId: 'cont-1',
      }),
      {
        ...approvalWaitFixture({
          id: 'invalid-absolute-path',
          sessionId: session.id,
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          subject: 'Absolute path should be dropped',
          approvalRef: 'approval-abs',
          continuationId: 'cont-2',
        }),
        consolePath: '/admin/approvals/approval-abs',
      },
      {
        ...approvalWaitFixture({
          id: 'invalid-relative-path',
          sessionId: session.id,
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          subject: 'Relative path should be dropped',
          approvalRef: 'approval-rel',
          continuationId: 'cont-3',
        }),
        consolePath: 'overview/approvals/approval-rel',
      },
      {
        ...approvalWaitFixture({
          id: 'invalid-mismatched-surface',
          sessionId: session.id,
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          subject: 'Surface mismatch should be dropped',
          approvalRef: 'approval-mismatch',
          continuationId: 'cont-4',
        }),
        consolePath: 'admin/approvals/approval-mismatch',
      },
    ];
    const state = serializeState({
      sessions: [session],
      approvalWaits,
    });

    expect(state.approvalWaits.map((record) => record.id)).toEqual(['valid-wait']);
    expect(state.sessions[0].lifecycle).toBe('ready');
  });

  it('preserves valid sessions and audits while dropping malformed waits during in-memory serialization', () => {
    const now = new Date(0).toISOString();
    const session = sessionFixture('session-1', 'ready', now);
    const validWait = approvalWaitFixture({
      id: 'valid-wait',
      sessionId: session.id,
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-valid',
      continuationId: 'cont-valid',
    });
    const invalidWait = {
      ...approvalWaitFixture({
        id: 'invalid-wait',
        sessionId: session.id,
        consoleSurface: 'admin',
        authorityClass: 'privileged-operation',
        approvalRef: 'approval-bad-id',
        continuationId: 'cont-invalid',
      }),
      id: 2,
      checkAttempt: 0.5,
    } as unknown as ApprovalWaitRecord;
    const state = serializeState({
      sessions: [session],
      approvalWaits: [validWait, invalidWait],
      auditEvents: [
        {
          id: 'audit-1',
          at: now,
          actorId: 'user',
          action: 'session.close',
          resource: session.id,
          outcome: 'allowed',
          summary: 'kept',
        },
      ],
    });

    expect(state.sessions.map((value) => value.id)).toEqual([session.id]);
    expect(state.auditEvents.map((value) => value.id)).toEqual(['audit-1']);
    expect(state.approvalWaits.map((value) => value.id)).toEqual(['valid-wait']);
  });

  it('rejects mixed malformed approval waits in durable JSON load without dropping other state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-'));
    const path = join(dir, 'state.json');
    const now = new Date(0).toISOString();
    const session = sessionFixture('session-2', 'ready', now);
    const validWait = approvalWaitFixture({
      id: 'json-valid',
      sessionId: session.id,
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-valid',
      continuationId: 'cont-json-valid',
    });
    const invalidWait = {
      ...approvalWaitFixture({
        id: 'json-invalid',
        sessionId: session.id,
        consoleSurface: 'admin',
        authorityClass: 'privileged-operation',
        approvalRef: 'approval-json-bad',
        continuationId: 'cont-json-invalid',
      }),
      consolePath: '/admin/approvals/approval-json-bad',
    } as unknown as ApprovalWaitRecord;
    writeFileSync(path, JSON.stringify({
      sessions: [session],
      approvalWaits: [invalidWait, validWait],
      auditEvents: [{
        id: 'audit-1',
        at: now,
        actorId: 'user',
        action: 'session.close',
        resource: session.id,
        outcome: 'allowed',
        summary: 'persisted',
      }],
    }));
    const persistence = createJsonFilePersistence(path);

    expect(persistence.load().sessions.map((value) => value.id)).toEqual([session.id]);
    expect(persistence.load().auditEvents.map((value) => value.id)).toEqual(['audit-1']);
    expect(persistence.load().approvalWaits.map((value) => value.id)).toEqual(['json-valid']);
  });

  it('rejects malformed approval-wait timestamps and accepts timezone-aware ISO values', () => {
    const now = new Date(0).toISOString();
    const base = approvalWaitFixture({
      sessionId: 'session',
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-time',
      continuationId: 'cont-time',
      checkAttempt: 0,
    });
    const mutableFields: Array<keyof ApprovalWaitRecord> = [
      'nextCheckAt',
      'createdAt',
      'updatedAt',
      'decisionObservedAt',
      'dispatchReservedAt',
      'resumedAt',
    ];
    for (const field of mutableFields) {
      const wait = {
        ...base,
        [field]: 'August 2, 2026',
      } as unknown as ApprovalWaitRecord;
      expect(
        serializeState({ approvalWaits: [wait] }).approvalWaits,
      ).toEqual([]);

      const impossible = {
        ...base,
        [field]: '2026-02-31T00:00:00Z',
      } as unknown as ApprovalWaitRecord;
      expect(
        serializeState({ approvalWaits: [impossible] }).approvalWaits,
      ).toEqual([]);
    }

    expect(
      serializeState({ approvalWaits: [base] }).approvalWaits,
    ).toEqual([{
      ...base,
      id: 'approval-wait-valid',
      nextCheckAt: now,
      decisionObservedAt: now,
    }]);
  });

  it('rejects negative or fractional checkAttempt values', () => {
    const wait = approvalWaitFixture({
      sessionId: 'session',
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-attempt',
      continuationId: 'cont-attempt',
      checkAttempt: -1,
    });
    expect(serializeState({ approvalWaits: [wait] }).approvalWaits).toEqual([]);
    const fractional = approvalWaitFixture({
      sessionId: 'session',
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-attempt-fractional',
      continuationId: 'cont-attempt-fractional',
      checkAttempt: 1.5,
    });
    expect(serializeState({ approvalWaits: [fractional] }).approvalWaits).toEqual([]);
  });

  it('retains all active waits and newest terminal waits under bound, including retention bounds env override', () => {
    const now = Date.UTC(2026, 7, 2);
    const state = serializeState({
      approvalWaits: [
        approvalWaitFixture({
          id: 'active-newest',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'pending',
          updatedAt: new Date(now - 100).toISOString(),
          approvalRef: 'approval-active-newest',
          continuationId: 'cont-active-newest',
        }),
        approvalWaitFixture({
          id: 'active-middle',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'verification-delayed',
          updatedAt: new Date(now - 200).toISOString(),
          approvalRef: 'approval-active-middle',
          continuationId: 'cont-active-middle',
        }),
        approvalWaitFixture({
          id: 'terminal-newest',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'rejected',
          updatedAt: new Date(now - 50).toISOString(),
          approvalRef: 'approval-term-newest',
          continuationId: 'cont-term-newest',
        }),
        approvalWaitFixture({
          id: 'terminal-middle',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'expired',
          updatedAt: new Date(now - 300).toISOString(),
          approvalRef: 'approval-term-middle',
          continuationId: 'cont-term-middle',
        }),
        approvalWaitFixture({
          id: 'terminal-oldest',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'revoked',
          updatedAt: new Date(now - 500).toISOString(),
          approvalRef: 'approval-term-oldest',
          continuationId: 'cont-term-oldest',
        }),
      ],
    }, {
      now,
      maxApprovalWaits: 4,
    });
    expect(state.approvalWaits).toHaveLength(4);
    expect(state.approvalWaits.map((record) => record.id).sort()).toEqual([
      'active-middle',
      'active-newest',
      'terminal-middle',
      'terminal-newest',
    ]);

    const previousValue = process.env.ROADEX_MAX_APPROVAL_WAITS;
    process.env.ROADEX_MAX_APPROVAL_WAITS = '2';
    const envBound = serializeState({
      approvalWaits: [
        approvalWaitFixture({
          id: 'env-active-1',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'pending',
          approvalRef: 'approval-env-1',
          continuationId: 'cont-env-1',
        }),
        approvalWaitFixture({
          id: 'env-terminal',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'rejected',
          approvalRef: 'approval-env-term',
          continuationId: 'cont-env-term',
        }),
      ],
      now,
      maxApprovalWaits: 10,
    });
    process.env.ROADEX_MAX_APPROVAL_WAITS = previousValue;

    expect(envBound.approvalWaits.map((record) => record.id)).toEqual(['env-active-1']);
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
        expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
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
      deviceBridgeRequests: [{
        id: 'request',
        userId: 'user',
        sessionId: 'session',
        projectId: 'roadex',
        artifactId: 'artifact',
        artifactSha256: 'a'.repeat(64),
        inventoryBindingId: 'binding',
        deviceIdentityTag: 'c'.repeat(64),
        operation: 'esp32.flash',
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      }, {
        id: 'legacy-request',
        userId: 'user',
        sessionId: 'session',
        projectId: 'roadex',
        artifactId: 'artifact',
        artifactSha256: 'a'.repeat(64),
        expectedDeviceId: 'raw-device-id',
        operation: 'esp32.flash',
        status: 'pending',
        createdAt: now,
        expiresAt: now,
      } as unknown as DeviceBridgeRequestRecord],
      deviceBridgeApprovals: [{
        id: 'approval',
        requestId: 'request',
        userId: 'user',
        sessionId: 'session',
        projectId: 'roadex',
        artifactId: 'artifact',
        artifactSha256: 'a'.repeat(64),
        inventoryBindingId: 'binding',
        deviceIdentityTag: 'c'.repeat(64),
        credentialDigest: 'b'.repeat(64),
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
        inventoryBindingId: 'binding',
        deviceIdentityTag: 'c'.repeat(64),
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
    expect(state.deviceBridgeRequests.map((record) => record.id)).toEqual(['request']);
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
        inventoryBindingId: 'binding',
        deviceIdentityTag: 'c'.repeat(64),
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

function approvalWaitFixture(overrides: Partial<ApprovalWaitRecord> = {}): ApprovalWaitRecord {
  const now = new Date(0).toISOString();
  return {
    id: 'approval-wait-valid',
    sessionId: 'session',
    userId: 'user',
    projectId: 'roadex',
    workspaceId: 'workspace',
    managedThreadId: '019f7337-df2e-75c1-b245-5e3588a6c5aa',
    provider: 'overseer',
    approvalRef: 'approval',
    resourceRef: 'resource-1',
    authorityClass: 'privileged-operation',
    consoleSurface: 'admin',
    subject: 'Reconcile change approval',
    state: 'pending',
    decisionVersion: 'v1',
    continuationId: 'cont',
    checkAttempt: 0,
    nextCheckAt: now,
    createdAt: now,
    updatedAt: now,
    decisionObservedAt: now,
    ...overrides,
  };
}
