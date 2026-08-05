import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commitAuthoritativeRegistration,
  createJsonFilePersistence,
  createMemoryPersistence,
  serializeState,
  type JsonFilePersistenceOperations,
  type StatePersistence,
} from '../src/server/statePersistence';
import type { ApprovalWaitRecord } from '../src/shared/approvalWorkflowContracts';
import type { RoadexSession, StreamEvent } from '../src/shared/sessionContracts';
import type {
  DeviceArtifactMetadata,
  DeviceBridgeOperationRecord,
  DeviceBridgeRequestRecord,
  DeviceInventoryBindingRecord,
} from '../src/shared/deviceBridgeContracts';

describe('state persistence', () => {
  it('synchronizes the file and parent directory around the atomic rename before save succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-order-'));
    const path = join(dir, 'state.json');
    const order: string[] = [];
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath) => {
        order.push('file-open');
        return openSync(filePath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o600);
      },
      writeFile: (fd, contents) => {
        order.push('file-write');
        writeFileSync(fd, contents, { encoding: 'utf8' });
      },
      syncFile: (fd) => {
        order.push('file-sync');
        fsyncSync(fd);
      },
      closeFile: (fd) => {
        order.push('file-close');
        closeSync(fd);
      },
      rename: (from, to) => {
        order.push('rename');
        renameSync(from, to);
      },
      openDirectory: (directory) => {
        order.push('directory-open');
        return openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      },
      syncDirectory: (fd) => {
        order.push('directory-sync');
        fsyncSync(fd);
      },
      closeDirectory: (fd) => {
        order.push('directory-close');
        closeSync(fd);
      },
      unlink: unlinkSync,
    };

    createJsonFilePersistence(path, operations).save(serializeState({}));

    expect(order).toEqual([
      'file-open',
      'file-write',
      'file-sync',
      'file-close',
      'rename',
      'directory-open',
      'directory-sync',
      'directory-close',
    ]);
  });

  it('uses exclusive no-follow creation for a unique temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-temp-flags-'));
    const path = join(dir, 'state.json');
    const flags: number[] = [];
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath, fileFlags, mode) => {
        flags.push(fileFlags);
        return openSync(filePath, fileFlags, mode);
      },
      writeFile: (fd, contents) => writeFileSync(fd, contents, { encoding: 'utf8' }),
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: unlinkSync,
    };

    createJsonFilePersistence(path, operations).save(serializeState({}));

    expect(flags).toEqual([
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY,
    ]);
  });

  it('does not follow the legacy temporary-path symlink or overwrite its target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-temp-symlink-'));
    const path = join(dir, 'state.json');
    const target = join(dir, 'unrelated.json');
    const legacyTemp = `${path}.tmp`;
    writeFileSync(target, 'unrelated-content', { mode: 0o600 });
    symlinkSync(target, legacyTemp);

    createJsonFilePersistence(path).save(serializeState({}));

    expect(readFileSync(target, 'utf8')).toBe('unrelated-content');
    expect(readFileSync(path, 'utf8')).toContain('"sessions": []');
    expect(readFileSync(legacyTemp, 'utf8')).toBe('unrelated-content');
  });

  it('cleans only its owned temporary file after a pre-rename write failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-write-failure-'));
    const path = join(dir, 'state.json');
    const opened: string[] = [];
    const unlinked: string[] = [];
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath, fileFlags, mode) => {
        opened.push(filePath);
        return openSync(filePath, fileFlags, mode);
      },
      writeFile: () => { throw new Error('write-failed'); },
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: (filePath) => {
        unlinked.push(filePath);
        unlinkSync(filePath);
      },
    };

    expect(() => createJsonFilePersistence(path, operations).save(serializeState({})))
      .toThrowError('write-failed');
    expect(unlinked).toEqual(opened);
    expect(opened).toHaveLength(1);
    expect(() => readFileSync(opened[0])).toThrow();
  });

  it('closes and removes its owned temporary file after a pre-rename close failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-close-failure-'));
    const path = join(dir, 'state.json');
    const opened: string[] = [];
    let closeCalls = 0;
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath, fileFlags, mode) => {
        opened.push(filePath);
        return openSync(filePath, fileFlags, mode);
      },
      writeFile: (fd, contents) => writeFileSync(fd, contents, { encoding: 'utf8' }),
      syncFile: fsyncSync,
      closeFile: (fd) => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('close-failed');
        closeSync(fd);
      },
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: unlinkSync,
    };

    expect(() => createJsonFilePersistence(path, operations).save(serializeState({})))
      .toThrowError('close-failed');
    expect(closeCalls).toBe(2);
    expect(() => readFileSync(opened[0])).toThrow();
  });

  it('removes only its owned temporary file when rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-rename-failure-'));
    const path = join(dir, 'state.json');
    const opened: string[] = [];
    const unlinked: string[] = [];
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath, fileFlags, mode) => {
        opened.push(filePath);
        return openSync(filePath, fileFlags, mode);
      },
      writeFile: (fd, contents) => writeFileSync(fd, contents, { encoding: 'utf8' }),
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: () => { throw new Error('rename-failed'); },
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: (filePath) => {
        unlinked.push(filePath);
        unlinkSync(filePath);
      },
    };

    expect(() => createJsonFilePersistence(path, operations).save(serializeState({})))
      .toThrowError('rename-failed');
    expect(unlinked).toEqual(opened);
    expect(() => readFileSync(opened[0])).toThrow();
  });

  it('preserves the original pre-rename failure when cleanup also fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-cleanup-failure-'));
    const path = join(dir, 'state.json');
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath, fileFlags, mode) => openSync(filePath, fileFlags, mode),
      writeFile: () => { throw new Error('write-failed-first'); },
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: () => { throw new Error('cleanup-failed-second'); },
    };

    expect(() => createJsonFilePersistence(path, operations).save(serializeState({})))
      .toThrowError('write-failed-first');
  });

  it('does not unlink a pre-existing path when temporary creation fails exclusively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-exclusive-failure-'));
    const path = join(dir, 'state.json');
    const unrelated = `${path}.tmp`;
    writeFileSync(unrelated, 'keep-me', { mode: 0o600 });
    const operations: JsonFilePersistenceOperations = {
      openFile: () => { throw Object.assign(new Error('exclusive-create-failed'), { code: 'EEXIST' }); },
      writeFile: () => { throw new Error('unreachable'); },
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: unlinkSync,
    };

    expect(() => createJsonFilePersistence(path, operations).save(serializeState({})))
      .toThrowError('exclusive-create-failed');
    expect(readFileSync(unrelated, 'utf8')).toBe('keep-me');
  });

  it('never unlinks the temporary path after rename succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-no-post-rename-unlink-'));
    const path = join(dir, 'state.json');
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath, fileFlags, mode) => openSync(filePath, fileFlags, mode),
      writeFile: (fd, contents) => writeFileSync(fd, contents, { encoding: 'utf8' }),
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: fsyncSync,
      closeDirectory: closeSync,
      unlink: () => { throw new Error('post-rename-unlink'); },
    };

    expect(() => createJsonFilePersistence(path, operations).save(serializeState({}))).not.toThrow();
    expect(readFileSync(path, 'utf8')).toContain('"sessions": []');
  });

  it('returns indeterminate when the parent directory cannot be synchronized after rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-directory-fsync-'));
    const path = join(dir, 'state.json');
    const durable = createJsonFilePersistence(path);
    const operations: JsonFilePersistenceOperations = {
      openFile: (filePath) => openSync(filePath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o600),
      writeFile: (fd, contents) => writeFileSync(fd, contents, { encoding: 'utf8' }),
      syncFile: fsyncSync,
      closeFile: closeSync,
      rename: renameSync,
      openDirectory: (directory) => openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY),
      syncDirectory: () => { throw new Error('directory-fsync-failed'); },
      closeDirectory: closeSync,
      unlink: unlinkSync,
    };
    const persistence = createJsonFilePersistence(path, operations);
    const session = sessionFixture('directory-fsync-session', 'paused', new Date(0).toISOString());
    const wait = approvalWaitFixture({ sessionId: session.id, id: 'directory-fsync-wait' });
    session.waitingApproval = {
      waitId: wait.id,
      approvalRef: wait.approvalRef,
      subject: wait.subject,
      consoleSurface: wait.consoleSurface,
      state: wait.state,
      updatedAt: wait.updatedAt,
    };
    const stream = streamEvent('directory-fsync-stream', session.id);
    const audit = {
      id: 'directory-fsync-audit',
      at: new Date(0).toISOString(),
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.register' as const,
      resource: session.id,
      outcome: 'allowed' as const,
      summary: `wait=${wait.id};state=${wait.state};console=${wait.consoleSurface}`,
    };
    const snapshot = serializeState({ sessions: [session], approvalWaits: [wait], streamEvents: [stream], auditEvents: [audit] });

    expect(commitAuthoritativeRegistration(persistence, snapshot, {
      wait,
      session: { id: session.id, lifecycle: session.lifecycle, waitingApproval: session.waitingApproval },
      streamEvent: stream,
      auditEvent: audit,
    })).toBe('indeterminate');
    expect(durable.readAuthoritative?.().outcome).toBe('valid');
    expect(durable.load().approvalWaits).toEqual([wait]);
  });

  it('strictly reconciles a durable registration when save throws after the atomic rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-registration-commit-'));
    const durable = createJsonFilePersistence(join(dir, 'state.json'));
    const session = sessionFixture('session-1', 'paused', new Date(0).toISOString());
    const wait = approvalWaitFixture({ sessionId: session.id, id: 'wait-registration' });
    session.waitingApproval = {
      waitId: wait.id,
      approvalRef: wait.approvalRef,
      subject: wait.subject,
      consoleSurface: wait.consoleSurface,
      state: wait.state,
      updatedAt: wait.updatedAt,
    };
    const stream = streamEvent('registration-stream', session.id);
    const audit = {
      id: 'audit-registration',
      at: new Date(0).toISOString(),
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.register' as const,
      resource: session.id,
      outcome: 'allowed' as const,
      summary: `wait=${wait.id};state=${wait.state};console=${wait.consoleSurface}`,
    };
    const snapshot = serializeState({
      sessions: [session],
      approvalWaits: [wait],
      streamEvents: [stream],
      auditEvents: [audit],
    });
    const persistence: StatePersistence = {
      load: durable.load,
      readAuthoritative: durable.readAuthoritative,
      save: (next) => {
        durable.save(next);
        throw new Error('rename-already-completed');
      },
    };

    const outcome = commitAuthoritativeRegistration(persistence, snapshot, {
      wait,
      session: {
        id: session.id,
        lifecycle: session.lifecycle,
        waitingApproval: session.waitingApproval,
      },
      streamEvent: stream,
      auditEvent: audit,
    });

    expect(outcome).toBe('committed');
    expect(durable.load().approvalWaits).toEqual([wait]);
    expect(durable.load().streamEvents).toEqual([stream]);
    expect(durable.load().auditEvents).toEqual([audit]);
  });

  it('classifies a structurally valid empty authoritative state as not committed', () => {
    const persistence = createMemoryPersistence();
    const session = sessionFixture('session-1', 'paused', new Date(0).toISOString());
    const wait = approvalWaitFixture({ sessionId: session.id, id: 'wait-absent' });
    const stream = streamEvent('stream-absent', session.id);
    const audit = {
      id: 'audit-absent',
      at: new Date(0).toISOString(),
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.register' as const,
      resource: session.id,
      outcome: 'allowed' as const,
      summary: 'wait=wait-absent;state=pending;console=admin',
    };

    expect(commitAuthoritativeRegistration(persistence, serializeState({}), {
      wait,
      session: { id: session.id, lifecycle: session.lifecycle },
      streamEvent: stream,
      auditEvent: audit,
    })).toBe('not-committed');
  });

  it('does not treat malformed authoritative JSON as confirmed absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-authoritative-read-'));
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"sessions": []}', { mode: 0o600 });
    const persistence = createJsonFilePersistence(path);

    expect(persistence.readAuthoritative?.()).toEqual({ outcome: 'indeterminate' });
  });

  it('converts a strict authoritative probe exception into indeterminate', () => {
    const session = sessionFixture('session-1', 'paused', new Date(0).toISOString());
    const wait = approvalWaitFixture({ sessionId: session.id, id: 'wait-probe-error' });
    const stream = streamEvent('stream-probe-error', session.id);
    const audit = {
      id: 'audit-probe-error',
      at: new Date(0).toISOString(),
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.register' as const,
      resource: session.id,
      outcome: 'allowed' as const,
      summary: 'registration',
    };
    const persistence: StatePersistence = {
      load: () => serializeState({}),
      save: () => {},
      readAuthoritative: () => { throw new Error('probe-failed'); },
    };

    expect(commitAuthoritativeRegistration(persistence, serializeState({}), {
      wait,
      session: { id: session.id, lifecycle: session.lifecycle },
      streamEvent: stream,
      auditEvent: audit,
    })).toBe('indeterminate');
  });

  it('classifies a partial or conflicting authoritative tuple as indeterminate', () => {
    const session = sessionFixture('session-1', 'paused', new Date(0).toISOString());
    const wait = approvalWaitFixture({ sessionId: session.id, id: 'wait-partial' });
    const stream = streamEvent('stream-partial', session.id);
    const audit = {
      id: 'audit-partial',
      at: new Date(0).toISOString(),
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.register' as const,
      resource: session.id,
      outcome: 'allowed' as const,
      summary: 'registration',
    };
    const partial = createMemoryPersistence({ approvalWaits: [wait] });
    const persistence: StatePersistence = {
      load: partial.load,
      readAuthoritative: partial.readAuthoritative,
      save: () => {},
    };

    expect(commitAuthoritativeRegistration(persistence, serializeState({}), {
      wait,
      session: { id: session.id, lifecycle: session.lifecycle },
      streamEvent: stream,
      auditEvent: audit,
    })).toBe('indeterminate');
  });

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

  it('rejects waits with non-enumerable and symbol own extras while preserving session and audit on in-memory sanitization', () => {
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
    const pollutions = [
      {
        label: 'non-enumerable string extra',
        mutate: (polluted: Record<string, unknown>) => {
          Object.defineProperty(polluted, 'credential', {
            value: 'sneaky',
            enumerable: false,
            configurable: true,
            writable: true,
          });
        },
      },
      {
        label: 'symbol own extra',
        mutate: (polluted: Record<string, unknown>) => {
          (polluted as Record<symbol, unknown>)[Symbol('extra')] = 'sneaky';
        },
      },
    ] as const;

    for (const pollution of pollutions) {
      const slug = pollution.label.replace(/ /g, '-');
      const polluted = {
        ...approvalWaitFixture({
          id: `invalid-${slug}`,
          sessionId: session.id,
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          approvalRef: `approval-${slug}`,
          continuationId: `cont-${slug}`,
        }),
      } as Record<string, unknown>;
      pollution.mutate(polluted);

      const state = serializeState({
        sessions: [session],
        approvalWaits: [
          polluted as unknown as ApprovalWaitRecord,
          validWait,
        ],
        auditEvents: [{
          id: 'audit-valid',
          at: now,
          actorId: 'user',
          action: 'session.close',
          resource: session.id,
          outcome: 'allowed',
          summary: 'kept',
        }],
      });

      expect(state.sessions.map((value) => value.id)).toEqual([session.id]);
      expect(state.auditEvents.map((value) => value.id)).toEqual(['audit-valid']);
      expect(state.approvalWaits.map((value) => value.id)).toEqual(['valid-wait']);
    }
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

  it('rejects waits with extra own properties in durable JSON load while preserving sibling state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadex-state-'));
    const path = join(dir, 'state.json');
    const now = new Date(0).toISOString();
    const session = sessionFixture('session-3', 'ready', now);
    const validWait = approvalWaitFixture({
      id: 'json-valid',
      sessionId: session.id,
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-json-valid',
      continuationId: 'cont-json-valid',
    });
    const extras = [
      { key: 'consolePath', value: '/admin/approvals/approval-extra' },
      { key: 'continuationText', value: 'unexpected' },
      { key: 'credential', value: 'sneaky' },
      { key: 'unexpected', value: 'still-bad' },
    ] as const;

    for (const extra of extras) {
      const polluted = {
        ...approvalWaitFixture({
          id: `json-invalid-${extra.key}`,
          sessionId: session.id,
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          approvalRef: `approval-json-invalid-${extra.key}`,
          continuationId: `cont-json-invalid-${extra.key}`,
        }),
        [extra.key]: extra.value,
      } as unknown as ApprovalWaitRecord;
      writeFileSync(path, JSON.stringify({
        sessions: [session],
        approvalWaits: [polluted, validWait],
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
    }
  });

  it('does not inherit optional approval-wait fields from object prototypes', () => {
    const now = new Date(0).toISOString();
    const base = {
      ...approvalWaitFixture({
        id: 'prototype-optional',
        sessionId: 'session',
        consoleSurface: 'admin',
        authorityClass: 'privileged-operation',
        approvalRef: 'approval-prototype-optional',
        continuationId: 'cont-prototype-optional',
      }),
      nextCheckAt: now,
      updatedAt: now,
      subject: 'Prototype optional inheritance',
    } as Record<string, unknown>;
    delete base.decisionObservedAt;
    delete base.dispatchReservedAt;
    delete base.runnerRunId;
    delete base.successorOfWaitId;
    delete base.resumedAt;
    const optionalFieldsWithPrototypeValues = [
      { field: 'decisionObservedAt', value: now },
      { field: 'dispatchReservedAt', value: now },
      { field: 'runnerRunId', value: 'proto-runner' },
      { field: 'successorOfWaitId', value: 'proto-predecessor' },
      { field: 'resumedAt', value: now },
    ] as const;
    for (const optional of optionalFieldsWithPrototypeValues) {
      const wait = Object.create({
        [optional.field]: optional.value,
      });
      Object.assign(wait, base);
      const state = serializeState({ approvalWaits: [wait as unknown as ApprovalWaitRecord] });
      expect(state.approvalWaits).toHaveLength(1);
      const sanitized = state.approvalWaits[0] as Record<string, unknown>;
      expect(sanitized.id).toBe('prototype-optional');
      expect(optional.field in sanitized).toBe(false);
      expect(sanitized[optional.field]).toBeUndefined();
    }
  });

  it('preserves a canonical successor wait predecessor binding', () => {
    const successor = {
      ...approvalWaitFixture({
        id: 'approval-wait-successor',
        state: 'approved-resume-queued',
      }),
      successorOfWaitId: 'approval-wait-closed',
    } as ApprovalWaitRecord & { successorOfWaitId: string };

    expect(serializeState({ approvalWaits: [successor] }).approvalWaits).toEqual([successor]);

    const malformed = { ...successor, successorOfWaitId: ' approval-wait-closed' };
    expect(serializeState({ approvalWaits: [malformed] }).approvalWaits).toEqual([]);
  });

  it('rejects malformed approval-wait timestamps and accepts timezone-aware ISO values', () => {
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

    const validOffsets = [
      '2026-08-02T18:00:00+02:00',
      '2026-08-02T18:00:00-05:30',
    ];
    for (const field of mutableFields) {
      for (const timestamp of validOffsets) {
        const wait = {
          ...base,
          [field]: timestamp,
        } as unknown as ApprovalWaitRecord;
        expect(
          serializeState({ approvalWaits: [wait] }).approvalWaits[0]?.[field],
        ).toBe(new Date(timestamp).toISOString());
      }
    }

    const malformedOffsets = [
      '2026-08-02T18:00:00+2:00',
      '2026-08-02T18:00:00-5:30',
      '2026-08-02T18:00:00+24:00',
      '2026-08-02T18:00:00-05:60',
      '2026-08-02T18:00:00+14:30',
      '2026-08-02T18:00:00-14:30',
      '2026-08-02T18:00:00+15:00',
      '2026-08-02T18:00:00-15:00',
    ];
    for (const field of mutableFields) {
      for (const timestamp of malformedOffsets) {
        const wait = {
          ...base,
          [field]: timestamp,
        } as unknown as ApprovalWaitRecord;
        expect(serializeState({ approvalWaits: [wait] }).approvalWaits).toEqual([]);
      }
    }
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

  it('keeps canonical approval-wait identity fields and rejects whitespace/control variants', () => {
    const base = approvalWaitFixture({
      id: 'canonical',
      sessionId: 'session',
      consoleSurface: 'admin',
      authorityClass: 'privileged-operation',
      approvalRef: 'approval-value',
      continuationId: 'cont-value',
    });
    const preserved = {
      ...base,
      id: 'preserved',
      approvalRef: 'approval with internal spaces',
      continuationId: 'continuation with spaces',
      resourceRef: 'resource-with-hyphen',
    } as ApprovalWaitRecord;
    const whitespaceCollision = {
      ...base,
      id: 'whitespace-collision',
      approvalRef: ' approval-value ',
    } as unknown as ApprovalWaitRecord;
    const newlineCollision = {
      ...base,
      id: 'newline-collision',
      continuationId: 'cont\nvalue',
    } as unknown as ApprovalWaitRecord;
    const nulCollision = {
      ...base,
      id: 'nul-collision',
      managedThreadId: `${base.managedThreadId}\u0000`,
    } as unknown as ApprovalWaitRecord;
    const c1Collision = {
      ...base,
      id: `c1-collision-${'\u0085'}`,
    } as unknown as ApprovalWaitRecord;

    const state = serializeState({
      approvalWaits: [whitespaceCollision, newlineCollision, nulCollision, c1Collision, base, preserved],
    });
    expect(state.approvalWaits.map((record) => record.id).sort()).toEqual([
      'canonical',
      'preserved',
    ]);
    expect(
      state.approvalWaits.find((record) => record.id === 'preserved')?.approvalRef,
    ).toBe('approval with internal spaces');
    expect(
      state.approvalWaits.find((record) => record.id === 'preserved')?.continuationId,
    ).toBe('continuation with spaces');
  });

  it('retains all active waits when active count exceeds max', () => {
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
          id: 'active-earliest',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'approved-resume-queued',
          updatedAt: new Date(now - 300).toISOString(),
          approvalRef: 'approval-active-earliest',
          continuationId: 'cont-active-earliest',
        }),
        approvalWaitFixture({
          id: 'active-middle',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'security-failure',
          updatedAt: new Date(now - 250).toISOString(),
          approvalRef: 'approval-active-middle',
          continuationId: 'cont-active-middle',
        }),
        approvalWaitFixture({
          id: 'terminal-in-window',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'rejected',
          updatedAt: new Date(now - 150).toISOString(),
          approvalRef: 'approval-term-in-window',
          continuationId: 'cont-term-in-window',
        }),
        approvalWaitFixture({
          id: 'terminal-stale',
          sessionId: 'session',
          consoleSurface: 'admin',
          authorityClass: 'privileged-operation',
          state: 'expired',
          updatedAt: new Date(now - 3_000).toISOString(),
          approvalRef: 'approval-term-stale',
          continuationId: 'cont-term-stale',
        }),
      ],
    }, {
      now,
      maxApprovalWaits: 2,
    });
    expect(state.approvalWaits).toHaveLength(3);
    expect(state.approvalWaits.map((record) => record.id).sort()).toEqual([
      'active-earliest',
      'active-middle',
      'active-newest',
    ]);
  });

  it('limits fresh terminal waits by ROADEX_MAX_APPROVAL_WAITS after retaining all active waits', () => {
    const now = Date.UTC(2026, 7, 2);
    const previousMax = process.env.ROADEX_MAX_APPROVAL_WAITS;
    const previousRetention = process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS;
    process.env.ROADEX_MAX_APPROVAL_WAITS = '3';
    process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS = '10000';
    try {
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
            id: 'active-older',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'approved-resume-queued',
            updatedAt: new Date(now - 200).toISOString(),
            approvalRef: 'approval-active-older',
            continuationId: 'cont-active-older',
          }),
          approvalWaitFixture({
            id: 'terminal-freshest',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'rejected',
            updatedAt: new Date(now - 50).toISOString(),
            approvalRef: 'approval-term-freshest',
            continuationId: 'cont-term-freshest',
          }),
          approvalWaitFixture({
            id: 'terminal-older',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'revoked',
            updatedAt: new Date(now - 60).toISOString(),
            approvalRef: 'approval-term-older',
            continuationId: 'cont-term-older',
          }),
          approvalWaitFixture({
            id: 'terminal-stale-similar',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'expired',
            updatedAt: new Date(now - 120).toISOString(),
            approvalRef: 'approval-term-similar',
            continuationId: 'cont-term-similar',
          }),
        ],
      }, { now });
      expect(state.approvalWaits).toHaveLength(3);
      expect(state.approvalWaits.map((record) => record.id).sort()).toEqual([
        'active-newest',
        'active-older',
        'terminal-freshest',
      ]);
    } finally {
      if (previousMax === undefined) {
        delete process.env.ROADEX_MAX_APPROVAL_WAITS;
      } else {
        process.env.ROADEX_MAX_APPROVAL_WAITS = previousMax;
      }
      if (previousRetention === undefined) {
        delete process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS;
      } else {
        process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS = previousRetention;
      }
    }
  });

  it('lets explicit maxApprovalWaits options override ROADEX_MAX_APPROVAL_WAITS', () => {
    const now = Date.UTC(2026, 7, 2);
    const previousMax = process.env.ROADEX_MAX_APPROVAL_WAITS;
    process.env.ROADEX_MAX_APPROVAL_WAITS = '1';
    try {
      const state = serializeState({
        approvalWaits: [
          approvalWaitFixture({
            id: 'active-single',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'pending',
            updatedAt: new Date(now - 10).toISOString(),
            approvalRef: 'approval-active-single',
            continuationId: 'cont-active-single',
          }),
          approvalWaitFixture({
            id: 'terminal-freshest',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'rejected',
            updatedAt: new Date(now - 1).toISOString(),
            approvalRef: 'approval-term-freshest',
            continuationId: 'cont-term-freshest',
          }),
          approvalWaitFixture({
            id: 'terminal-second',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'expired',
            updatedAt: new Date(now - 2).toISOString(),
            approvalRef: 'approval-term-second',
            continuationId: 'cont-term-second',
          }),
          approvalWaitFixture({
            id: 'terminal-third',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'revoked',
            updatedAt: new Date(now - 3).toISOString(),
            approvalRef: 'approval-term-third',
            continuationId: 'cont-term-third',
          }),
        ],
      }, { now, maxApprovalWaits: 3 });
      expect(state.approvalWaits).toHaveLength(3);
      expect(state.approvalWaits.map((record) => record.id).sort()).toEqual([
        'active-single',
        'terminal-freshest',
        'terminal-second',
      ]);
    } finally {
      if (previousMax === undefined) {
        delete process.env.ROADEX_MAX_APPROVAL_WAITS;
      } else {
        process.env.ROADEX_MAX_APPROVAL_WAITS = previousMax;
      }
    }
  });

  it('expires stale terminal waits based on ROADEX_APPROVAL_WAIT_RETENTION_MS', () => {
    const now = Date.UTC(2026, 7, 2);
    const previousRetention = process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS;
    const previousMax = process.env.ROADEX_MAX_APPROVAL_WAITS;
    process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS = '1000';
    process.env.ROADEX_MAX_APPROVAL_WAITS = '10';
    try {
      const state = serializeState({
        approvalWaits: [
          approvalWaitFixture({
            id: 'active',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'pending',
            updatedAt: new Date(now).toISOString(),
            approvalRef: 'approval-active',
            continuationId: 'cont-active',
          }),
          approvalWaitFixture({
            id: 'terminal-fresh',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'rejected',
            updatedAt: new Date(now - 500).toISOString(),
            approvalRef: 'approval-term-fresh',
            continuationId: 'cont-term-fresh',
          }),
          approvalWaitFixture({
            id: 'terminal-stale',
            sessionId: 'session',
            consoleSurface: 'admin',
            authorityClass: 'privileged-operation',
            state: 'revoked',
            updatedAt: new Date(now - 5_000).toISOString(),
            approvalRef: 'approval-term-stale',
            continuationId: 'cont-term-stale',
          }),
        ],
      }, { now });
      expect(state.approvalWaits.map((record) => record.id).sort()).toEqual([
        'active',
        'terminal-fresh',
      ]);
    } finally {
      if (previousRetention === undefined) {
        delete process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS;
      } else {
        process.env.ROADEX_APPROVAL_WAIT_RETENTION_MS = previousRetention;
      }
      if (previousMax === undefined) {
        delete process.env.ROADEX_MAX_APPROVAL_WAITS;
      } else {
        process.env.ROADEX_MAX_APPROVAL_WAITS = previousMax;
      }
    }
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
