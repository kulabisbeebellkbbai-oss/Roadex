import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApprovalContinuationDispatchResult,
  type ApprovalCoordinatorCallbacks,
  type ApprovalSessionCapability,
  type RegisterApprovalWaitInput,
  type RegisterApprovalWaitResult,
  ApprovalCoordinator,
} from '../src/server/approvalCoordinator.js';
import { buildApprovalContinuation } from '../src/server/approvalContinuation.js';
import type { ApprovalWaitRecord, NormalizedApprovalStatus, WaitingApprovalSummary } from '../src/shared/approvalWorkflowContracts.js';
import type { AuditEvent, RoadexSession } from '../src/shared/sessionContracts.js';
import type { ApprovalStatusProvider } from '../src/server/approvalStatusProvider.js';

const BASE = new Date('2026-08-02T18:00:00.000Z');

function clockWithState(initialMs = BASE.getTime()) {
  let nowMs = initialMs;
  return {
    now: () => new Date(nowMs).toISOString(),
    set: (nextMs: number) => {
      nowMs = nextMs;
    },
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function fixtureSession(overrides: Partial<RoadexSession> = {}): RoadexSession {
  return {
    id: 'session-1',
    userId: 'user-1',
    workspace: {
      id: 'workspace-1',
      name: 'Test Workspace',
      root: '/workspace/root',
    },
    lifecycle: 'ready',
    runnerMode: 'codex',
    transport: 'websocket',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: BASE.toISOString(),
    updatedAt: BASE.toISOString(),
    codexThreadId: 'thread-1',
    managedThreadId: 'thread-1',
    ...overrides,
  };
}

function bindSessionToWait(session: RoadexSession, wait: ApprovalWaitRecord): void {
  session.lifecycle = 'paused';
  session.waitingApproval = {
    waitId: wait.id,
    approvalRef: wait.approvalRef,
    subject: wait.subject,
    consoleSurface: wait.consoleSurface,
    state: wait.state,
    updatedAt: wait.updatedAt,
  };
}

function fixtureCapability(overrides: Partial<ApprovalSessionCapability> = {}): ApprovalSessionCapability {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    resourceRef: 'resource.one',
    managedThreadId: 'thread-1',
    ...overrides,
  };
}

function fixtureStatus(overrides: Partial<NormalizedApprovalStatus> = {}): NormalizedApprovalStatus {
  return {
    provider: 'overseer',
    approvalRef: 'admin.roadex.test',
    authorityClass: 'privileged-operation',
    decision: 'pending',
    decisionVersion: `sha256:${'a'.repeat(64)}`,
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    resourceRef: 'resource.one',
    subject: 'Restart test service',
    updatedAt: '2026-08-02T18:00:00.000Z',
    ...overrides,
  };
}

function fixtureWait(overrides: Partial<ApprovalWaitRecord> = {}): ApprovalWaitRecord {
  return {
    id: 'wait-1',
    sessionId: 'session-1',
    userId: 'user-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    managedThreadId: 'thread-1',
    provider: 'overseer',
    approvalRef: 'admin.roadex.test',
    resourceRef: 'resource.one',
    authorityClass: 'privileged-operation',
    consoleSurface: 'admin',
    subject: 'Restart test service',
    state: 'pending',
    decisionVersion: `sha256:${'a'.repeat(64)}`,
    continuationId: deriveContinuationId('session-1', 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
    checkAttempt: 0,
    nextCheckAt: '2026-08-02T18:00:02.000Z',
    createdAt: '2026-08-02T18:00:00.000Z',
    updatedAt: '2026-08-02T18:00:00.000Z',
    ...overrides,
  };
}

function statusSequenceProvider(sequence: Array<NormalizedApprovalStatus>): ApprovalStatusProvider {
  const source = [...sequence];
  return {
    getStatus: vi.fn(async () => {
      const next = source.shift();
      if (next === undefined) {
        throw new Error('status-missing');
      }
      return next;
    }),
  };
}

function callbacksBuilder(overrides: {
  persist?: () => void | Promise<void>;
  queueContinuation?: () => ApprovalContinuationDispatchResult | Promise<ApprovalContinuationDispatchResult>;
  publish?: (sessionId: string, message: string) => void;
  audit?: (action: AuditEvent['action'], outcome: AuditEvent['outcome'], summary: string, resource: string) => void;
} = {}) {
  const events: string[] = [];
  const audits: AuditEvent[] = [];

  return {
    callbacks: {
      persist: async () => {
        if (overrides.persist) {
          await overrides.persist();
        }
      },
      publish: (sessionId: string, message: string) => {
        if (overrides.publish) {
          return overrides.publish(sessionId, message);
        }
        events.push(`[${sessionId}] ${message}`);
      },
      audit: (action, outcome, summary, resource) => {
        if (overrides.audit) {
          return overrides.audit(action, outcome, summary, resource);
        }
        audits.push({
          id: `audit-${audits.length + 1}`,
          at: BASE.toISOString(),
          actorId: 'actor-1',
          action,
          outcome,
          summary,
          resource,
        });
      },
      queueContinuation: async () => {
        if (overrides.queueContinuation) {
          return overrides.queueContinuation();
        }
        return { status: 'started', runnerRunId: 'runner-1' };
      },
    } satisfies ApprovalCoordinatorCallbacks,
    events,
    audits,
  };
}

function deriveContinuationId(sessionId: string, approvalRef: string, decisionVersion: string): string {
  const canonical = JSON.stringify([sessionId, approvalRef, decisionVersion]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function deriveSuccessorContinuationId(
  waitId: string,
  sessionId: string,
  approvalRef: string,
  decisionVersion: string,
): string {
  const canonical = JSON.stringify([
    'roadex-approval-successor-v1',
    waitId,
    sessionId,
    approvalRef,
    decisionVersion,
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

describe('ApprovalCoordinator', () => {
  it('registers a pending approval and pauses the session with full wait result', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits: ApprovalWaitRecord[] = [];
    const cb = callbacksBuilder();
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus()]),
      cb.callbacks,
      { clock, idSource: { generateWaitId: () => 'wait-fixed' } },
    );

    const result = await coordinator.register(fixtureCapability(), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    } satisfies RegisterApprovalWaitInput);

    expect(result).toMatchObject({ ok: true } as RegisterApprovalWaitResult);
    if (!result.ok) {
      return;
    }
    expect(result.wait).toMatchObject({
      waitId: 'wait-fixed',
      state: 'pending',
      consoleSurface: 'admin',
      approvalRef: 'admin.roadex.test',
      subject: 'Restart test service',
    });
    expect(result.wait.updatedAt).toBe('2026-08-02T18:00:00.000Z');
    expect(cb.events).toHaveLength(1);
    expect(cb.events[0]).toContain('Admin Console');
    expect(cb.events[0]).toContain('Roadex will continue automatically');

    expect(sessions[0].lifecycle).toBe('paused');
    expect(sessions[0].waitingApproval).toMatchObject({
      waitId: 'wait-fixed',
      state: 'pending',
      consoleSurface: 'admin',
    });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      id: 'wait-fixed',
      continuationId: deriveContinuationId('session-1', 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
      checkAttempt: 0,
      nextCheckAt: '2026-08-02T18:00:02.000Z',
    });
  });

  it('returns exact waiting summary and rejects register payload extras/inherited fields', async () => {
    const coordinator = new ApprovalCoordinator(
      [],
      [fixtureSession()],
      statusSequenceProvider([fixtureStatus()]),
      callbacksBuilder().callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'wait-fixed' } },
    );

    const result = await coordinator.register(
      fixtureCapability(),
      {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
      extra: 'x',
      } as RegisterApprovalWaitInput,
    );

    expect(result).toMatchObject({ ok: false, code: 'scope-mismatch' });

    const inherited = Object.create({ provider: 'overseer', approvalRef: 'admin.roadex.test' }) as RegisterApprovalWaitInput;
    const inheritedResult = await coordinator.register(fixtureCapability(), inherited);
    expect(inheritedResult).toMatchObject({ ok: false, code: 'scope-mismatch' });

    const validResult = await coordinator.register(fixtureCapability(), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });
    expect(validResult).toMatchObject({ ok: true });
    if (!validResult.ok) {
      return;
    }
    expect(Object.keys(validResult.wait).sort()).toEqual([
      'approvalRef',
      'consolePath',
      'consoleSurface',
      'state',
      'subject',
      'updatedAt',
      'waitId',
    ]);
    expect((validResult.wait as Partial<WaitingApprovalSummary>).consolePath).toBeUndefined();
  });

  it('maps project-workflow approvals to overview console and publishes fixed routing copy', async () => {
    const sessions = [fixtureSession()];
    const waits: ApprovalWaitRecord[] = [];
    const cb = callbacksBuilder();
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ authorityClass: 'project-workflow' })]),
      cb.callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'wait-overview' } },
    );

    const result = await coordinator.register(fixtureCapability(), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });

    expect(result).toMatchObject({ ok: true, wait: { consoleSurface: 'overview' } });
    expect(cb.events[0]).toContain('Overview Console');
    expect(cb.events[0]).not.toContain('Admin Console');
  });

  it('rejects lifecycle, ownership, thread and malformed scope mismatches', async () => {
    const rejectable: Array<{ session: RoadexSession; label: string }> = [
      { session: fixtureSession({ lifecycle: 'closed' }), label: 'closed' },
      { session: fixtureSession({ lifecycle: 'blocked' }), label: 'blocked' },
      { session: fixtureSession({ lifecycle: 'streaming' }), label: 'streaming' },
      { session: fixtureSession({ managedThreadId: 'wrong-thread' }), label: 'unbound' },
      { session: fixtureSession({ userId: 'other-user' }), label: 'ownership' },
    ];

    for (const entry of rejectable) {
      const coordinator = new ApprovalCoordinator(
        [],
        [entry.session],
        statusSequenceProvider([fixtureStatus()]),
        callbacksBuilder().callbacks,
        { clock: clockWithState() },
      );

      const result = await coordinator.register(
        {
          ...fixtureCapability(),
          ...(entry.label === 'ownership' ? { userId: 'intruder' } : {}),
          ...(entry.label === 'unbound' ? { managedThreadId: 'wrong-thread' } : {}),
        },
        { provider: 'overseer', approvalRef: 'admin.roadex.test' },
      );
      expect(result).toMatchObject({ ok: false, code: 'scope-mismatch' });
      expect(result).not.toMatchObject({ ok: true } as RegisterApprovalWaitResult);
    }

    const noManaged = await new ApprovalCoordinator(
      [],
      [fixtureSession({ managedThreadId: undefined })],
      statusSequenceProvider([fixtureStatus()]),
      callbacksBuilder().callbacks,
      { clock: clockWithState() },
    ).register({ ...fixtureCapability(), managedThreadId: 'thread-1' }, { provider: 'overseer', approvalRef: 'admin.roadex.test' });
    expect(noManaged).toMatchObject({ ok: false, code: 'scope-mismatch' });
  });

  it('rejects non-pending decisions and duplicate active waits', async () => {
    const nonPending: Array<NormalizedApprovalStatus['decision']> = [
      'approved',
      'changes-requested',
      'rejected',
      'expired',
      'revoked',
    ];

    for (const decision of nonPending) {
      const result = await new ApprovalCoordinator(
        [],
        [fixtureSession()],
        statusSequenceProvider([fixtureStatus({ decision })]),
        callbacksBuilder().callbacks,
        { clock: clockWithState() },
      ).register(
        fixtureCapability(),
        { provider: 'overseer', approvalRef: 'admin.roadex.test' },
      );

      expect(result).toMatchObject({ ok: false, code: 'approval-not-pending' });
    }

    const duplicate = await new ApprovalCoordinator(
      [fixtureWait()],
      [fixtureSession()],
      statusSequenceProvider([fixtureStatus()]),
      callbacksBuilder().callbacks,
      { clock: clockWithState() },
    ).register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });
    expect(duplicate).toMatchObject({ ok: false, code: 'active-wait-exists' });
  });

  it('serializes concurrent registrations and keeps exactly one pending wait', async () => {
    const gate = deferred<NormalizedApprovalStatus>();
    const session = fixtureSession();
    const waits: ApprovalWaitRecord[] = [];
    let idSequence = 0;
    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      {
        getStatus: vi.fn(async () => {
          const status = await gate.promise;
          return status;
        }),
      },
      callbacksBuilder().callbacks,
      {
        clock: clockWithState(),
        idSource: { generateWaitId: () => `wait-race-${++idSequence}` },
      },
    );

    const first = coordinator.register(fixtureCapability({ sessionId: 'session-1' }), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });
    const second = coordinator.register(fixtureCapability({ sessionId: 'session-1' }), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });
    await Promise.resolve();
    gate.resolve(fixtureStatus());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    const successes = [firstResult, secondResult].filter((result) => result.ok === true);
    const collisions = [firstResult, secondResult].filter((result) => !result.ok && result.code === 'active-wait-exists');

    expect(successes).toHaveLength(1);
    expect(collisions).toHaveLength(1);
    expect(waits).toHaveLength(1);
    expect(session.lifecycle).toBe('paused');
  });

  it('rechecks lifecycle and ownership after registration fetch before commit', async () => {
    const checks: Array<{ label: string; mutate: (session: RoadexSession) => void }> = [
      { label: 'lifecycle', mutate: (session) => { session.lifecycle = 'blocked'; } },
      { label: 'user', mutate: (session) => { session.userId = 'intruder'; } },
      { label: 'workspace', mutate: (session) => { session.workspace.id = 'workspace-other'; } },
      { label: 'thread', mutate: (session) => { session.managedThreadId = 'thread-other'; } },
    ];

    for (const check of checks) {
      const gate = deferred<NormalizedApprovalStatus>();
      const waits: ApprovalWaitRecord[] = [];
      const session = fixtureSession();
      const cb = callbacksBuilder({
        persist: async () => {
          throw new Error(`persist-should-not-run-${check.label}`);
        },
      });
      const coordinator = new ApprovalCoordinator(
        waits,
        [session],
        {
          getStatus: vi.fn(async () => {
            return gate.promise.then(() => fixtureStatus());
          }),
        },
        {
          ...cb.callbacks,
          publish: cb.callbacks.publish,
        },
        { clock: clockWithState(), idSource: { generateWaitId: () => `wait-after-fetch-${check.label}` } },
      );

      const resultPromise = coordinator.register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });
      await Promise.resolve();

      check.mutate(session);
      gate.resolve(fixtureStatus());

      const result = await resultPromise;
      expect(result).toMatchObject({ ok: false, code: 'scope-mismatch' });
      expect(waits).toHaveLength(0);
      expect(session.waitingApproval).toBeUndefined();
      expect(cb.events).toHaveLength(0);
      expect(cb.audits).toHaveLength(0);
    }
  });

  it('reserves wait IDs globally across concurrent registrations in different sessions', async () => {
    const statuses = [fixtureStatus(), fixtureStatus()];
    const waits: ApprovalWaitRecord[] = [];
    const sessions = [
      fixtureSession({ id: 'session-1' }),
      fixtureSession({ id: 'session-2', managedThreadId: 'thread-2', codexThreadId: 'thread-2' }),
    ];

    let idCalls = 0;
    const idSource = {
      generateWaitId: () => {
        const next = idCalls === 0 ? 'wait-dup' : idCalls === 1 ? 'wait-dup' : `wait-${idCalls}`;
        idCalls += 1;
        return next;
      },
    };

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider(statuses),
      callbacksBuilder().callbacks,
      { clock: clockWithState(), idSource },
    );

    const first = coordinator.register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });
    const second = coordinator.register(
      fixtureCapability({ sessionId: 'session-2', managedThreadId: 'thread-2' }),
      { provider: 'overseer', approvalRef: 'admin.roadex.test' },
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({ ok: true });
    if (!firstResult.ok || !secondResult.ok) {
      return;
    }
    expect(firstResult.wait.waitId).not.toBe(secondResult.wait.waitId);
    expect(waits).toHaveLength(2);
    expect(new Set(waits.map((wait) => wait.id)).size).toBe(2);
  });

  it('releases successful wait ID reservations once the persisted wait owns the ID', async () => {
    const waits: ApprovalWaitRecord[] = [];
    const sessions = [
      fixtureSession({ id: 'session-1' }),
      fixtureSession({ id: 'session-2', managedThreadId: 'thread-2', codexThreadId: 'thread-2' }),
    ];
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus(), fixtureStatus()]),
      callbacksBuilder().callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'wait-reusable' } },
    );

    const first = await coordinator.register(
      fixtureCapability(),
      { provider: 'overseer', approvalRef: 'admin.roadex.test' },
    );
    expect(first).toMatchObject({ ok: true });

    waits.splice(0, waits.length);
    sessions[0].lifecycle = 'closed';
    delete sessions[0].waitingApproval;

    const second = await coordinator.register(
      fixtureCapability({ sessionId: 'session-2', managedThreadId: 'thread-2' }),
      { provider: 'overseer', approvalRef: 'admin.roadex.test' },
    );

    expect(second).toMatchObject({ ok: true });
    if (second.ok) {
      expect(second.wait.waitId).toBe('wait-reusable');
    }
  });

  it('rejects generated wait id collisions and invalid IDs without persistence', async () => {
    const collideSession = fixtureSession();
    const waits = [fixtureWait({ id: 'collision-id', sessionId: 'other-session' })];
    const resultCollision = await new ApprovalCoordinator(
      waits,
      [collideSession],
      statusSequenceProvider([fixtureStatus()]),
      callbacksBuilder().callbacks,
      {
        clock: clockWithState(),
        idSource: { generateWaitId: () => 'collision-id' },
      },
    ).register(fixtureCapability({ sessionId: 'session-1' }), { provider: 'overseer', approvalRef: 'admin.roadex.test' });

    expect(resultCollision).toMatchObject({ ok: false, code: 'scope-mismatch' });

    const resultInvalidId = await new ApprovalCoordinator(
      waits,
      [fixtureSession({ id: 'session-2' })],
      statusSequenceProvider([fixtureStatus({ approvalRef: 'admin.roadex.test' })]),
      callbacksBuilder().callbacks,
      {
        clock: clockWithState(),
        idSource: { generateWaitId: () => 'bad id' },
      },
    ).register(
      fixtureCapability({ sessionId: 'session-2' }),
      { provider: 'overseer', approvalRef: 'admin.roadex.test' },
    );

    expect(resultInvalidId).toMatchObject({ ok: false, code: 'scope-mismatch' });

    const resultInvalidIdRunes = await new ApprovalCoordinator(
      waits,
      [fixtureSession({ id: 'session-3' })],
      statusSequenceProvider([fixtureStatus({ approvalRef: 'admin.roadex.test' })]),
      callbacksBuilder().callbacks,
      {
        clock: clockWithState(),
        idSource: { generateWaitId: () => 'wait\rid' },
      },
    ).register(
      fixtureCapability({ sessionId: 'session-3' }),
      { provider: 'overseer', approvalRef: 'admin.roadex.test' },
    );

    expect(resultInvalidIdRunes).toMatchObject({ ok: false, code: 'scope-mismatch' });
  });

  it('keeps lifecycle and wait state on provider unavailable after persist failure rollback', async () => {
    const unavailable = await new ApprovalCoordinator(
      [],
      [fixtureSession()],
      { getStatus: vi.fn(async () => { throw new Error('provider-down'); }) },
      callbacksBuilder().callbacks,
      { clock: clockWithState() },
    ).register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });
    expect(unavailable).toMatchObject({ ok: false, code: 'provider-unavailable' });

    const waits: ApprovalWaitRecord[] = [];
    const sessions = [fixtureSession()];
    const cb = callbacksBuilder({ persist: () => { throw new Error('persist-down'); } });
    const result = await new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus()]),
      cb.callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'wait-persist' } },
    ).register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });

    expect(result).toMatchObject({ ok: false, code: 'provider-unavailable' });
    expect(waits).toHaveLength(0);
    expect(sessions[0].lifecycle).toBe('ready');
    expect(cb.events).toHaveLength(0);
  });

  it('ignores callback failures after durable persistence', async () => {
    const sessions = [fixtureSession()];
    const waits: ApprovalWaitRecord[] = [];
    const cb = callbacksBuilder();
    cb.callbacks.publish = () => { throw new Error('publish-failed'); };
    cb.callbacks.audit = () => { throw new Error('audit-failed'); };

    const result = await new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus()]),
      cb.callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'wait-ok' } },
    ).register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });

    expect(result).toMatchObject({ ok: true });
    expect(waits).toHaveLength(1);
    expect(sessions[0].lifecycle).toBe('paused');
    expect(cb.events).toHaveLength(0);
  });

  it('keeps transition state when terminal publish/audit callbacks fail after persistence', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits: ApprovalWaitRecord[] = [
      fixtureWait({
        nextCheckAt: clock.now(),
        sessionId: 'session-1',
      }),
    ];
    const cb = callbacksBuilder({
      publish: () => {
        throw new Error('publish-failed');
      },
      audit: () => {
        throw new Error('audit-failed');
      },
    });

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'changes-requested' })]),
      cb.callbacks,
      { clock },
    );

    await coordinator.tick();
    expect(waits[0].state).toBe('changes-requested');
    expect(waits[0].updatedAt).toBe(clock.now());
    expect(sessions[0].lifecycle).toBe('ready');
    expect(sessions[0].waitingApproval).toBeUndefined();
    expect(cb.events).toHaveLength(0);
  });

  it('does not publish or audit when persistence fails on terminal transition', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits: ApprovalWaitRecord[] = [
      fixtureWait({
        nextCheckAt: clock.now(),
        sessionId: 'session-1',
      }),
    ];
    const order: string[] = [];
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'changes-requested' })]),
      {
        ...callbacksBuilder().callbacks,
        persist: async () => {
          order.push('persist');
          throw new Error('persist-down');
        },
        publish: () => {
          order.push('publish');
        },
        audit: () => {
          order.push('audit');
        },
      },
      { clock },
    );

    await coordinator.tick();
    expect(order).toEqual(['persist']);
    expect(waits[0].state).toBe('pending');
    expect(waits[0].checkAttempt).toBe(0);
    expect(sessions[0].lifecycle).toBe('paused');
    expect(sessions[0].waitingApproval).toMatchObject({
      waitId: waits[0].id,
      state: 'pending',
    });
  });

  it('persists, projects, publishes, and audits non-approval terminal transitions', async () => {
    const terminalDecisions: Array<NormalizedApprovalStatus['decision']> = [
      'changes-requested',
      'rejected',
      'expired',
      'revoked',
    ];

    for (const decision of terminalDecisions) {
      const clock = clockWithState();
      const session = fixtureSession({ id: `session-${decision}` });
      const wait = fixtureWait({
        id: `wait-${decision}`,
        sessionId: `session-${decision}`,
        state: 'pending',
        nextCheckAt: clock.now(),
        checkAttempt: 0,
      });
      const waits = [wait];
      const sessions = [session];
      const persisted: Array<{ session: Pick<RoadexSession, 'lifecycle' | 'waitingApproval'>; wait: ApprovalWaitRecord }> = [];
      const published: string[] = [];
      const audits: AuditEvent[] = [];
      const statusVersion = `sha256:${'b'.repeat(64)}`;

      const coordinator = new ApprovalCoordinator(
        waits,
        sessions,
        statusSequenceProvider([
          fixtureStatus({ decision, decisionVersion: statusVersion, subject: `Terminal action ${decision}` }),
        ]),
        {
          ...callbacksBuilder().callbacks,
          persist: async () => {
            persisted.push({
              session: {
                lifecycle: session.lifecycle,
              },
              wait: { ...wait },
            });
          },
          publish: (_sessionId, message) => {
            published.push(message);
          },
          audit: (action, outcome, summary, resource) => {
            audits.push({
              id: `audit-${audits.length + 1}`,
              at: clock.now(),
              actorId: 'actor-1',
              action,
              outcome,
              summary,
              resource,
            });
          },
        },
        { clock },
      );

      await coordinator.tick();

      expect(wait.state).toBe(decision);
      expect(wait.decisionVersion).toBe(statusVersion);
      expect(wait.continuationId).toBe(deriveContinuationId(wait.sessionId, wait.approvalRef, statusVersion));
      expect(persisted).toHaveLength(1);
      expect(persisted[0].session.lifecycle).toBe('ready');
      expect(session.lifecycle).toBe('ready');
      expect(session.waitingApproval).toBeUndefined();
      expect(published).toContain(`Roadex human approval result: ${decision}`);
      expect(audits).toHaveLength(1);
    }
  });

  it('persists, projects, publishes, and audits session-closed denials from dispatch', async () => {
    const clock = clockWithState();
    const session = fixtureSession({ id: 'session-session-closed' });
    const wait = fixtureWait({
      state: 'approved-resume-queued',
      sessionId: 'session-session-closed',
      continuationId: deriveContinuationId('session-session-closed', 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
      nextCheckAt: clock.now(),
      checkAttempt: 0,
    });
    bindSessionToWait(session, wait);
    const waits = [wait];
    const sessions = [session];
    const persisted: Array<{
      session: Pick<RoadexSession, 'lifecycle' | 'waitingApproval'>;
      wait: ApprovalWaitRecord;
    }> = [];
    const published: string[] = [];
    const audits: AuditEvent[] = [];
    const queueContinuation = vi.fn(async () => ({ status: 'denied', reason: 'session-closed' } satisfies ApprovalContinuationDispatchResult));

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'approved', decisionVersion: `sha256:${'b'.repeat(64)}` })]),
      {
        ...callbacksBuilder().callbacks,
        persist: async () => {
          persisted.push({
            session: {
              lifecycle: session.lifecycle,
            },
            wait: { ...wait },
          });
        },
        publish: (_sessionId, message) => {
          published.push(message);
        },
        audit: (action, outcome, summary, resource) => {
          audits.push({
            id: `audit-${audits.length + 1}`,
            at: clock.now(),
            actorId: 'actor-1',
            action,
            outcome,
            summary,
            resource,
          });
        },
        queueContinuation,
      },
      { clock },
    );

    await coordinator.tick();

    expect(wait.state).toBe('session-closed');
    expect(queueContinuation).toHaveBeenCalledTimes(1);
    expect(queueContinuation).toHaveBeenCalledWith(wait, buildApprovalContinuation(wait));
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    expect(persisted[persisted.length - 1].session.lifecycle).toBe('ready');
    expect(session.waitingApproval).toBeUndefined();
    expect(published).toContain('Roadex human approval result: session-closed');
    expect(audits).toHaveLength(1);
  });

  it('preserves decision metadata for trusted pending version drift, but advances on terminal versions', async () => {
    const clock = clockWithState();
    const baseVersion = `sha256:${'a'.repeat(64)}`;
    const driftVersion = `sha256:${'b'.repeat(64)}`;

    const pendingSession = fixtureSession({ id: 'session-version-pending' });
    const pendingWait = fixtureWait({
      sessionId: 'session-version-pending',
      decisionVersion: baseVersion,
      continuationId: deriveContinuationId('session-version-pending', 'admin.roadex.test', baseVersion),
      state: 'pending',
      nextCheckAt: clock.now(),
      checkAttempt: 0,
    });
    const pendingPersisted: Array<{ wait: ApprovalWaitRecord }> = [];

    await new ApprovalCoordinator(
      [pendingWait],
      [pendingSession],
      statusSequenceProvider([
        fixtureStatus({
          decision: 'pending',
          decisionVersion: driftVersion,
          subject: 'Drifting pending subject',
        }),
      ]),
      {
        ...callbacksBuilder().callbacks,
        persist: async () => {
          pendingPersisted.push({ wait: { ...pendingWait } });
        },
      },
      { clock },
    ).tick();

    expect(pendingWait.decisionVersion).toBe(baseVersion);
    expect(pendingWait.continuationId).toBe(deriveContinuationId('session-version-pending', 'admin.roadex.test', baseVersion));
    expect(pendingPersisted).toHaveLength(1);
    expect(pendingPersisted[0].wait.subject).toBe('Drifting pending subject');
    expect(pendingPersisted[0].wait.state).toBe('pending');

    const approvedSession = fixtureSession({ id: 'session-version-approved' });
    const approvedWait = fixtureWait({
      sessionId: 'session-version-approved',
      decisionVersion: baseVersion,
      continuationId: deriveContinuationId('session-version-approved', 'admin.roadex.test', baseVersion),
      state: 'pending',
      nextCheckAt: clock.now(),
      checkAttempt: 0,
    });
    bindSessionToWait(approvedSession, approvedWait);
    const approvedPersisted: Array<{ wait: ApprovalWaitRecord }> = [];
    const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-1' } satisfies ApprovalContinuationDispatchResult));

    await new ApprovalCoordinator(
      [approvedWait],
      [approvedSession],
      statusSequenceProvider([fixtureStatus({ decision: 'approved', decisionVersion: driftVersion, subject: 'Approved updated subject' })]),
      {
        ...callbacksBuilder().callbacks,
        persist: async () => {
          approvedPersisted.push({ wait: { ...approvedWait } });
        },
        queueContinuation,
      },
      { clock },
    ).tick();

    expect(approvedWait.decisionVersion).toBe(driftVersion);
    expect(approvedWait.continuationId).toBe(deriveContinuationId('session-version-approved', 'admin.roadex.test', driftVersion));
    expect(queueContinuation).toHaveBeenCalledTimes(1);
    expect(approvedPersisted[approvedPersisted.length - 1].wait.decisionVersion).toBe(driftVersion);
  });

  it('uses bounded exponential backoff and caps jitter within nominal delay', () => {
    const clock = clockWithState();
    const coordinator = new ApprovalCoordinator(
      [],
      [fixtureSession()],
      statusSequenceProvider([]),
      callbacksBuilder().callbacks,
      {
        clock,
        backoffJitter: (attempt) => {
          if (attempt === 3) {
            return -10_000;
          }
          if (attempt === 4) {
            return 20_000;
          }
          return 3;
        },
      },
    );

    expect(coordinator.nextCheckAt(clock.now(), 1)).toBe('2026-08-02T18:00:02.000Z');
    expect(coordinator.nextCheckAt(clock.now(), 2)).toBe('2026-08-02T18:00:05.000Z');
    expect(coordinator.nextCheckAt(clock.now(), 3)).toBe('2026-08-02T18:00:05.000Z');
    expect(coordinator.nextCheckAt(clock.now(), 4)).toBe('2026-08-02T18:00:30.000Z');
    expect(coordinator.nextCheckAt(clock.now(), 5)).toBe('2026-08-02T18:01:00.000Z');
  });

  it('moves from delay to pending after recovery and increments check attempts only on checks', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits = [fixtureWait({ nextCheckAt: clock.now(), checkAttempt: 0, state: 'pending' })];

    const failing = new ApprovalCoordinator(
      waits,
      sessions,
      { getStatus: vi.fn(async () => { throw new Error('network'); }) },
      callbacksBuilder().callbacks,
      { clock },
    );
    await failing.tick();
    expect(waits[0].state).toBe('verification-delayed');
    expect(waits[0].checkAttempt).toBe(1);

    const recovering = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus()]),
      callbacksBuilder().callbacks,
      { clock },
    );
    clock.set(BASE.getTime() + 6000);
    await recovering.tick();
    expect(waits[0].state).toBe('pending');
    expect(waits[0].checkAttempt).toBe(2);
  });

  it('schedules post-check provider retries as 5, 15, 30, 60 second sequence', async () => {
    const clock = clockWithState(BASE.getTime());
    const session = fixtureSession({ id: 'session-backoff' });
    const statusCallback = statusSequenceProvider([
      fixtureStatus(),
      fixtureStatus(),
      fixtureStatus(),
      fixtureStatus(),
      fixtureStatus(),
      fixtureStatus(),
    ]);
    const waits: ApprovalWaitRecord[] = [];

    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      statusCallback,
      callbacksBuilder().callbacks,
      { clock },
    );

    const result = await coordinator.register(fixtureCapability({ sessionId: 'session-backoff' }), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }

    const wait = waits[0];

    await coordinator.tick();
    expect(statusCallback.getStatus).toHaveBeenCalledTimes(1);
    expect(wait.checkAttempt).toBe(0);

    clock.set(BASE.getTime() + 2_000);
    await coordinator.tick();
    expect(statusCallback.getStatus).toHaveBeenCalledTimes(2);
    expect(wait.checkAttempt).toBe(1);
    expect(wait.nextCheckAt).toBe('2026-08-02T18:00:07.000Z');

    clock.set(BASE.getTime() + 7_000);
    await coordinator.tick();
    expect(statusCallback.getStatus).toHaveBeenCalledTimes(3);
    expect(wait.checkAttempt).toBe(2);
    expect(wait.nextCheckAt).toBe('2026-08-02T18:00:22.000Z');

    clock.set(BASE.getTime() + 22_000);
    await coordinator.tick();
    expect(statusCallback.getStatus).toHaveBeenCalledTimes(4);
    expect(wait.checkAttempt).toBe(3);
    expect(wait.nextCheckAt).toBe('2026-08-02T18:00:52.000Z');

    clock.set(BASE.getTime() + 52_000);
    await coordinator.tick();
    expect(statusCallback.getStatus).toHaveBeenCalledTimes(5);
    expect(wait.checkAttempt).toBe(4);
    expect(wait.nextCheckAt).toBe('2026-08-02T18:01:52.000Z');

    clock.set(BASE.getTime() + 112_000);
    await coordinator.tick();
    expect(statusCallback.getStatus).toHaveBeenCalledTimes(6);
    expect(wait.checkAttempt).toBe(5);
    expect(wait.nextCheckAt).toBe('2026-08-02T18:02:52.000Z');
  });

  it('restores generation and wait state when closeSessionWait persistence fails', async () => {
    const session = fixtureSession({ id: 'session-close-failed' });
    const wait = fixtureWait({
      id: 'wait-close-fail',
      sessionId: 'session-close-failed',
      state: 'pending',
      nextCheckAt: '2026-08-02T18:00:00.000Z',
      updatedAt: '2026-08-02T18:00:00.000Z',
      checkAttempt: 2,
    });
    const waits = [wait];
    const sessions = [session];

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([]),
      callbacksBuilder({
        persist: () => {
          throw new Error('close-persist-down');
        },
      }).callbacks,
      { clock: clockWithState() },
    );

    await expect(coordinator.closeSessionWait('session-close-failed')).rejects.toThrow(
      'approval_wait_close_persist_failed',
    );
    expect(wait.state).toBe('pending');
    expect(wait.nextCheckAt).toBe('2026-08-02T18:00:00.000Z');
    expect(wait.updatedAt).toBe('2026-08-02T18:00:00.000Z');
    expect(wait.runnerRunId).toBeUndefined();
    expect(session.lifecycle).toBe('paused');
  });

  it('does not copy status fields from mismatching provider status', async () => {
    const sessions = [fixtureSession()];
    const waits = [fixtureWait({ decisionVersion: `sha256:${'b'.repeat(64)}`, subject: 'Safe subject', nextCheckAt: '2026-08-02T18:00:00.000Z' })];
    const trustedContinuation = waits[0].continuationId;

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([
        fixtureStatus({
          projectId: 'other-project',
          subject: 'MALICIOUS SUBJECT',
          decisionVersion: `sha256:${'c'.repeat(64)}`,
          decision: 'pending',
        }),
      ]),
      callbacksBuilder().callbacks,
      { clock: clockWithState() },
    );

    await coordinator.tick();
    expect(waits[0].state).toBe('security-failure');
    expect(waits[0].subject).toBe('Safe subject');
    expect(waits[0].decisionVersion).toBe(`sha256:${'b'.repeat(64)}`);
    expect(waits[0].continuationId).toBe(trustedContinuation);
  });

  it('publishes fixed approval and terminal copy through session-aware publisher', async () => {
    const cb = callbacksBuilder();
    const coordinator = new ApprovalCoordinator(
      [],
      [fixtureSession()],
      statusSequenceProvider([fixtureStatus()]),
      cb.callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'wait-session' } },
    );

    const result = await coordinator.register(fixtureCapability(), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    expect(cb.events[0]).toContain('[session-1]');
    expect(cb.events[0]).toContain('Roadex is waiting');
  });

  it('publishes every active wait transition only after its canonical state persists', async () => {
    const orderedCallbacks = (
      wait: ApprovalWaitRecord,
      queueContinuation: ApprovalCoordinatorCallbacks['queueContinuation'] = async () => ({
        status: 'started',
        runnerRunId: 'runner-ordered',
      }),
    ): { callbacks: ApprovalCoordinatorCallbacks; order: string[] } => {
      const order: string[] = [];
      return {
        order,
        callbacks: {
          persist: () => { order.push(`persist:${wait.state}`); },
          publish: (_sessionId, message) => { order.push(`publish:${message}`); },
          audit: () => {},
          queueContinuation,
        },
      };
    };

    const clock = clockWithState();
    const delayedWait = fixtureWait({ state: 'pending', nextCheckAt: clock.now(), checkAttempt: 0 });
    const delayedSession = fixtureSession();
    bindSessionToWait(delayedSession, delayedWait);
    let providerAttempt = 0;
    const delayedCallbacks = orderedCallbacks(delayedWait);
    const delayedCoordinator = new ApprovalCoordinator(
      [delayedWait],
      [delayedSession],
      {
        getStatus: async () => {
          providerAttempt += 1;
          if (providerAttempt === 1) throw new Error('temporary');
          return fixtureStatus();
        },
      },
      delayedCallbacks.callbacks,
      { clock },
    );
    await delayedCoordinator.tick();
    clock.set(BASE.getTime() + 6_000);
    await delayedCoordinator.tick();
    expect(delayedCallbacks.order).toEqual([
      'persist:verification-delayed',
      'publish:Roadex human approval result: verification-delayed',
      'persist:pending',
      'publish:Roadex human approval result: pending',
    ]);

    const approvedWait = fixtureWait({ state: 'pending', nextCheckAt: clock.now() });
    const approvedSession = fixtureSession();
    bindSessionToWait(approvedSession, approvedWait);
    const approvedCallbacks = orderedCallbacks(approvedWait);
    await new ApprovalCoordinator(
      [approvedWait],
      [approvedSession],
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      approvedCallbacks.callbacks,
      { clock },
    ).tick();
    expect(approvedCallbacks.order).toEqual([
      'persist:approved-resume-queued',
      'publish:Roadex human approval result: approved-resume-queued',
      'persist:resume-dispatching',
      'publish:Roadex human approval result: resume-dispatching',
      'persist:resume-dispatching',
      'publish:Roadex human approval result: resume-dispatching',
    ]);

    const capacityWait = fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() });
    const capacitySession = fixtureSession();
    bindSessionToWait(capacitySession, capacityWait);
    const capacityCallbacks = orderedCallbacks(capacityWait, async () => ({
      status: 'capacity',
      retryAt: '2026-08-02T18:01:00.000Z',
    }));
    await new ApprovalCoordinator(
      [capacityWait],
      [capacitySession],
      statusSequenceProvider([]),
      capacityCallbacks.callbacks,
      { clock },
    ).tick();
    expect(capacityCallbacks.order).toEqual([
      'persist:resume-dispatching',
      'publish:Roadex human approval result: resume-dispatching',
      'persist:approved-resume-queued',
      'publish:Roadex human approval result: approved-resume-queued',
    ]);

    const ambiguousWait = fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() });
    const ambiguousSession = fixtureSession();
    bindSessionToWait(ambiguousSession, ambiguousWait);
    const ambiguousCallbacks = orderedCallbacks(ambiguousWait, async () => ({ status: 'ambiguous' }));
    await new ApprovalCoordinator(
      [ambiguousWait],
      [ambiguousSession],
      statusSequenceProvider([]),
      ambiguousCallbacks.callbacks,
      { clock },
    ).tick();
    expect(ambiguousCallbacks.order).toEqual([
      'persist:resume-dispatching',
      'publish:Roadex human approval result: resume-dispatching',
      'persist:resume-reconciliation-required',
      'publish:Roadex human approval result: resume-reconciliation-required',
    ]);

    const bindingWait = fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() });
    const bindingSession = fixtureSession();
    bindSessionToWait(bindingSession, bindingWait);
    const bindingCallbacks = orderedCallbacks(bindingWait, async () => {
      bindingSession.managedThreadId = 'thread-drifted';
      return { status: 'started', runnerRunId: 'runner-binding-loss' };
    });
    await new ApprovalCoordinator(
      [bindingWait],
      [bindingSession],
      statusSequenceProvider([]),
      bindingCallbacks.callbacks,
      { clock },
    ).tick();
    expect(bindingCallbacks.order).toEqual([
      'persist:resume-dispatching',
      'publish:Roadex human approval result: resume-dispatching',
      'persist:resume-reconciliation-required',
      'publish:Roadex human approval result: resume-reconciliation-required',
    ]);

    const recoveryWait = fixtureWait({
      state: 'resume-dispatching',
      runnerRunId: 'runner-lost',
      dispatchReservedAt: clock.now(),
    });
    const recoverySession = fixtureSession();
    bindSessionToWait(recoverySession, recoveryWait);
    const recoveryCallbacks = orderedCallbacks(recoveryWait);
    await new ApprovalCoordinator(
      [recoveryWait],
      [recoverySession],
      statusSequenceProvider([]),
      recoveryCallbacks.callbacks,
      { clock },
    ).recover();
    expect(recoveryCallbacks.order).toEqual([
      'persist:resume-reconciliation-required',
      'publish:Roadex human approval result: resume-reconciliation-required',
    ]);

    const failedWait = fixtureWait({ state: 'pending', nextCheckAt: clock.now() });
    const failedSession = fixtureSession();
    bindSessionToWait(failedSession, failedWait);
    const publish = vi.fn();
    await new ApprovalCoordinator(
      [failedWait],
      [failedSession],
      { getStatus: async () => { throw new Error('temporary'); } },
      callbacksBuilder({
        persist: () => { throw new Error('persist failed'); },
        publish,
      }).callbacks,
      { clock },
    ).tick();
    expect(publish).not.toHaveBeenCalled();
  });

  it('creates a fresh queued successor when a closed approval is already approved on reopen', async () => {
    const clock = clockWithState();
    const closedWait = fixtureWait({ state: 'session-closed', updatedAt: clock.now(), nextCheckAt: clock.now() });
    const session = fixtureSession({ lifecycle: 'closed' });
    session.lifecycle = 'closed';
    delete session.waitingApproval;
    const waits = [closedWait];
    const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-reopened' } as const));
    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      statusSequenceProvider([fixtureStatus({
        decision: 'approved',
        decisionVersion: closedWait.decisionVersion,
      })]),
      { ...callbacksBuilder().callbacks, queueContinuation },
      { clock, idSource: { generateWaitId: () => 'wait-reopened-approved' } },
    );

    await expect(coordinator.reopenSessionWait(session.id)).resolves.toBe('waiting');

    expect(waits).toHaveLength(2);
    expect(closedWait.state).toBe('session-closed');
    expect(waits[1]).toMatchObject({
      id: 'wait-reopened-approved',
      state: 'resume-dispatching',
      runnerRunId: 'runner-reopened',
      decisionVersion: closedWait.decisionVersion,
    });
    expect(waits[1].continuationId).toBe(deriveSuccessorContinuationId(
      'wait-reopened-approved',
      session.id,
      closedWait.approvalRef,
      closedWait.decisionVersion,
    ));
    expect(waits[1].continuationId).not.toBe(closedWait.continuationId);
    expect(waits[1].continuationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(session.lifecycle).toBe('paused');
    expect(session.waitingApproval?.waitId).toBe('wait-reopened-approved');
    expect(queueContinuation).toHaveBeenCalledTimes(1);
    expect(queueContinuation.mock.calls[0]?.[0].continuationId).toBe(waits[1].continuationId);
  });

  it('keeps a closed approval session closed when reopen provider verification fails', async () => {
    const closedWait = fixtureWait({ state: 'session-closed' });
    const session = fixtureSession({ lifecycle: 'closed' });
    session.lifecycle = 'closed';
    delete session.waitingApproval;
    const waits = [closedWait];
    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      { getStatus: async () => { throw new Error('provider unavailable'); } },
      callbacksBuilder().callbacks,
      { clock: clockWithState(), idSource: { generateWaitId: () => 'must-not-create' } },
    );

    await expect(coordinator.reopenSessionWait(session.id)).resolves.toBe('denied');
    expect(session.lifecycle).toBe('closed');
    expect(waits).toEqual([closedWait]);
  });

  it('rolls back a failed successor persistence and permits one fresh retry', async () => {
    const clock = clockWithState();
    const closedWait = fixtureWait({ state: 'session-closed', updatedAt: clock.now() });
    const session = fixtureSession({ lifecycle: 'closed' });
    session.lifecycle = 'closed';
    delete session.waitingApproval;
    const waits = [closedWait];
    const ids = ['wait-reopen-failed', 'wait-reopen-retry'];
    let persistAttempt = 0;
    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      statusSequenceProvider([
        fixtureStatus({ decision: 'pending', decisionVersion: closedWait.decisionVersion }),
        fixtureStatus({ decision: 'pending', decisionVersion: closedWait.decisionVersion }),
      ]),
      callbacksBuilder({
        persist: async () => {
          persistAttempt += 1;
          if (persistAttempt === 1) throw new Error('durable write failed');
        },
      }).callbacks,
      { clock, idSource: { generateWaitId: () => ids.shift() ?? 'unexpected-wait-id' } },
    );

    await expect(coordinator.reopenSessionWait(session.id)).resolves.toBe('denied');
    expect(session.lifecycle).toBe('closed');
    expect(waits).toEqual([closedWait]);

    await expect(coordinator.reopenSessionWait(session.id)).resolves.toBe('waiting');
    expect(waits).toHaveLength(2);
    expect(waits[1]).toMatchObject({
      id: 'wait-reopen-retry',
      state: 'pending',
      successorOfWaitId: closedWait.id,
      decisionVersion: closedWait.decisionVersion,
    });
    expect(waits[1].continuationId).not.toBe(closedWait.continuationId);
    expect(session.waitingApproval?.waitId).toBe('wait-reopen-retry');
  });

  it('linearizes concurrent reopen attempts to one fresh successor', async () => {
    const clock = clockWithState();
    const closedWait = fixtureWait({ state: 'session-closed', updatedAt: clock.now() });
    const session = fixtureSession({ lifecycle: 'closed' });
    session.lifecycle = 'closed';
    delete session.waitingApproval;
    const waits = [closedWait];
    const ids = ['wait-reopen-first', 'wait-reopen-second'];
    const persist = vi.fn(async () => {});
    const getStatus = vi.fn(async () => fixtureStatus({
      decision: 'pending',
      decisionVersion: closedWait.decisionVersion,
    }));
    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      { getStatus },
      callbacksBuilder({ persist }).callbacks,
      { clock, idSource: { generateWaitId: () => ids.shift() ?? 'unexpected-wait-id' } },
    );

    await expect(Promise.all([
      coordinator.reopenSessionWait(session.id),
      coordinator.reopenSessionWait(session.id),
    ])).resolves.toEqual(expect.arrayContaining(['waiting', 'denied']));

    expect(waits).toHaveLength(2);
    expect(waits[1]).toMatchObject({
      id: 'wait-reopen-first',
      state: 'pending',
      successorOfWaitId: closedWait.id,
    });
    expect(session.waitingApproval?.waitId).toBe('wait-reopen-first');
    expect(persist).toHaveBeenCalledTimes(1);
    await expect(coordinator.reopenSessionWait(session.id)).resolves.toBe('denied');
    expect(waits).toHaveLength(2);
  });

  it('transitions approved wait to resume-dispatching state with persistent dispatch reserve', async () => {
    const clock = clockWithState();
    const waits = [fixtureWait({ nextCheckAt: clock.now(), checkAttempt: 0 })];
    const session = fixtureSession();
    bindSessionToWait(session, waits[0]);
    const sessions = [session];

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      callbacksBuilder().callbacks,
      { clock },
    );

    await coordinator.tick();
    expect(waits[0].state).toBe('resume-dispatching');
    expect(waits[0].dispatchReservedAt).toBeDefined();
    expect(waits[0].runnerRunId).toBe('runner-1');
    expect(sessions[0].waitingApproval?.state).toBe('resume-dispatching');
  });

  it('retires restart-shaped blocking waits before a closed session can reopen and dispatch them', async () => {
    const blockingStates: ApprovalWaitRecord['state'][] = [
      'pending',
      'verification-delayed',
      'security-failure',
      'approved-resume-queued',
      'resume-dispatching',
      'resume-reconciliation-required',
    ];

    for (const state of blockingStates) {
      const clock = clockWithState();
      const sessionId = `session-closed-${state}`;
      const wait = fixtureWait({
        id: `wait-closed-${state}`,
        sessionId,
        state,
        nextCheckAt: clock.now(),
        continuationId: deriveContinuationId(sessionId, 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
      });
      const session = fixtureSession({ id: sessionId, lifecycle: 'closed' });
      bindSessionToWait(session, wait);
      session.lifecycle = 'closed';
      const oldContinuationId = wait.continuationId;
      const getStatus = vi.fn(async () => fixtureStatus());
      const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-closed' } as const));
      const persist = vi.fn(async () => {});
      const publish = vi.fn();
      const audit = vi.fn();
      const coordinator = new ApprovalCoordinator(
        [wait],
        [session],
        { getStatus },
        {
          ...callbacksBuilder({ persist, publish, audit }).callbacks,
          queueContinuation,
        },
        { clock },
      );

      expect(session.lifecycle).toBe('closed');
      expect(session.waitingApproval).toBeUndefined();
      expect(wait.state).toBe('session-closed');
      expect(coordinator.hasActiveWait(sessionId)).toBe(false);

      session.lifecycle = 'ready';
      await coordinator.tick();

      expect(session.lifecycle).toBe('ready');
      expect(session.waitingApproval).toBeUndefined();
      expect(wait.state).toBe('session-closed');
      expect(wait.continuationId).toBe(oldContinuationId);
      expect(getStatus).not.toHaveBeenCalled();
      expect(queueContinuation).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(sessionId, 'Roadex human approval result: session-closed');
      expect(audit).toHaveBeenCalledWith(
        'approval_wait.status',
        'denied',
        expect.stringContaining('state=session-closed'),
        sessionId,
      );
    }
  });

  it('linearizes restart retirement persistence with concurrent successor registration', async () => {
    for (const order of ['retirement-first', 'successor-first'] as const) {
      const clock = clockWithState();
      const oldWait = fixtureWait({
        id: `wait-old-${order}`,
        state: 'approved-resume-queued',
        nextCheckAt: clock.now(),
      });
      const oldContinuationId = oldWait.continuationId;
      const waits = [oldWait];
      const session = fixtureSession({ lifecycle: 'closed' });
      bindSessionToWait(session, oldWait);
      session.lifecycle = 'closed';
      const persistGates = [deferred<void>(), deferred<void>()];
      const persistStarts = [deferred<void>(), deferred<void>()];
      let persistCall = 0;
      let durable: {
        lifecycle: RoadexSession['lifecycle'];
        waitingApproval?: WaitingApprovalSummary;
        waits: ApprovalWaitRecord[];
      } | undefined;
      const persistedOrder: string[] = [];
      const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-stale' } as const));
      const coordinator = new ApprovalCoordinator(
        waits,
        [session],
        statusSequenceProvider([
          fixtureStatus({ decisionVersion: `sha256:${'b'.repeat(64)}` }),
        ]),
        {
          ...callbacksBuilder().callbacks,
          persist: async () => {
            const index = persistCall;
            persistCall += 1;
            const snapshot = {
              lifecycle: session.lifecycle,
              waitingApproval: session.waitingApproval ? { ...session.waitingApproval } : undefined,
              waits: waits.map((wait) => ({ ...wait })),
            };
            persistedOrder.push(snapshot.waitingApproval?.waitId ?? 'retirement-only');
            persistStarts[index].resolve();
            await persistGates[index].promise;
            durable = snapshot;
          },
          queueContinuation,
        },
        {
          clock,
          idSource: { generateWaitId: () => `wait-successor-${order}` },
        },
      );
      session.lifecycle = 'ready';

      let tickPromise: Promise<void>;
      let registerPromise: Promise<RegisterApprovalWaitResult>;
      if (order === 'retirement-first') {
        tickPromise = coordinator.tick();
        await persistStarts[0].promise;
        registerPromise = coordinator.register(
          fixtureCapability(),
          { provider: 'overseer', approvalRef: 'admin.roadex.test' },
        );
      } else {
        registerPromise = coordinator.register(
          fixtureCapability(),
          { provider: 'overseer', approvalRef: 'admin.roadex.test' },
        );
        await persistStarts[0].promise;
        tickPromise = coordinator.tick();
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(persistCall, order).toBe(1);

      persistGates[0].resolve();
      await persistStarts[1].promise;
      persistGates[1].resolve();
      const registerResult = await registerPromise;
      await tickPromise;

      expect(registerResult, order).toMatchObject({ ok: true });
      expect(persistedOrder, order).toEqual(order === 'retirement-first'
        ? ['retirement-only', `wait-successor-${order}`]
        : [`wait-successor-${order}`, `wait-successor-${order}`]);
      expect(durable?.lifecycle, order).toBe('paused');
      expect(durable?.waitingApproval?.waitId, order).toBe(`wait-successor-${order}`);
      expect(durable?.waits.find((wait) => wait.id === oldWait.id)?.state, order).toBe('session-closed');
      expect(durable?.waits.find((wait) => wait.id === `wait-successor-${order}`)?.state, order).toBe('pending');
      expect(session.waitingApproval?.waitId, order).toBe(`wait-successor-${order}`);
      expect(oldWait.state, order).toBe('session-closed');
      expect(registerResult.ok && registerResult.wait.waitId, order).toBe(`wait-successor-${order}`);
      expect(waits.find((wait) => wait.id === `wait-successor-${order}`)?.continuationId, order).not.toBe(oldContinuationId);
      expect(queueContinuation, order).not.toHaveBeenCalled();
    }
  });

  it('retries failed retirement per session without blocking or duplicating other closed sessions', async () => {
    const clock = clockWithState();
    const waits = [
      fixtureWait({ id: 'wait-retire-1', sessionId: 'session-1', state: 'pending', nextCheckAt: clock.now() }),
      fixtureWait({
        id: 'wait-retire-2',
        sessionId: 'session-2',
        state: 'approved-resume-queued',
        nextCheckAt: clock.now(),
        continuationId: deriveContinuationId('session-2', 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
      }),
    ];
    const sessions = [
      fixtureSession({ id: 'session-1', lifecycle: 'closed' }),
      fixtureSession({ id: 'session-2', lifecycle: 'closed' }),
    ];
    bindSessionToWait(sessions[0], waits[0]);
    bindSessionToWait(sessions[1], waits[1]);
    sessions.forEach((session) => { session.lifecycle = 'closed'; });
    let persistAttempt = 0;
    const publish = vi.fn();
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([]),
      callbacksBuilder({
        persist: async () => {
          persistAttempt += 1;
          if (persistAttempt === 1) {
            throw new Error('first-session-retirement-failed');
          }
        },
        publish,
      }).callbacks,
      { clock },
    );

    await coordinator.tick();

    expect(persistAttempt).toBe(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('session-2', 'Roadex human approval result: session-closed');

    await coordinator.tick();

    expect(persistAttempt).toBe(3);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith('session-1', 'Roadex human approval result: session-closed');
    expect(waits.every((wait) => wait.state === 'session-closed')).toBe(true);
  });

  it('maps dispatch results with strict shape validation', async () => {
    const clock = clockWithState();

    const symbol = Symbol('status');
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, 'status', {
      value: 'started',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(nonEnumerable, 'runnerRunId', {
      value: 'runner-1',
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const malformedTable: Array<{ result: unknown; expectedState: string; expectedAction?: 'security-failure' | 'session-closed' }> = [
      { result: { status: 'started' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'started', runnerRunId: 'runner-1', extra: 'x' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'capacity', retryAt: new Date(clock.now()).toISOString() }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'capacity', retryAt: '2026-08-02T19:00:00Z' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'capacity', retryAt: '2026-08-02T19:00:00.000Z', extra: 'x' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'capacity', retryAt: '2026-02-29T00:00:00.000Z' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'started', runnerRunId: 'wait\\nrun' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'started', runnerRunId: 'runner/1' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'denied', reason: 'bad' }, expectedState: 'resume-reconciliation-required' },
      { result: Object.create({ status: 'started', runnerRunId: 'runner-1' }), expectedState: 'resume-reconciliation-required' },
      { result: nonEnumerable as unknown, expectedState: 'resume-reconciliation-required' },
      {
        result: new Proxy({}, {
          get: () => {
            throw new Error('hostile-getter');
          },
        }) as unknown,
        expectedState: 'resume-reconciliation-required',
      },
      {
        result: (() => {
          const target = { status: 'started' } as Record<string, unknown> & { [symbol]: unknown };
          Object.defineProperty(target, symbol, { value: 'bad', enumerable: true });
          return target;
        })(),
        expectedState: 'resume-reconciliation-required',
      },
    ];

    for (const entry of malformedTable) {
      const sessionId = `session-${entry.expectedState}`;
      const wait = fixtureWait({
        state: 'approved-resume-queued',
        id: `wait-${entry.expectedState}`,
        sessionId,
        continuationId: deriveContinuationId(sessionId, 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
        checkAttempt: 1,
        nextCheckAt: clock.now(),
      });
      const session = fixtureSession({ id: sessionId });
      bindSessionToWait(session, wait);
      const coordinator = new ApprovalCoordinator(
        [wait],
        [session],
        statusSequenceProvider([fixtureStatus({ decision: 'approved', decisionVersion: `sha256:${'a'.repeat(64)}` })]),
        {
          ...callbacksBuilder(),
          callbacks: {
            ...callbacksBuilder().callbacks,
            queueContinuation: async () => entry.result as ApprovalContinuationDispatchResult,
          } as ApprovalCoordinatorCallbacks,
        }.callbacks,
        { clock },
      );

      await coordinator.tick();
      expect(wait.state).toBe(entry.expectedState);
    }

    const validScenarios = [
      { result: { status: 'capacity', retryAt: '2026-08-02T18:00:30.000Z' }, expectedState: 'approved-resume-queued' },
      { result: { status: 'ambiguous' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'denied', reason: 'session-closed' }, expectedState: 'session-closed' },
      { result: { status: 'denied', reason: 'scope-mismatch' }, expectedState: 'security-failure' },
    ];

    for (const scenario of validScenarios) {
      const sessionId = `session-${scenario.result.status}`;
      const wait = fixtureWait({
        state: 'approved-resume-queued',
        id: `wait-${scenario.result.status}`,
        sessionId,
        continuationId: deriveContinuationId(sessionId, 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
        nextCheckAt: clock.now(),
      });
      const session = fixtureSession({ id: sessionId });
      bindSessionToWait(session, wait);
      const coordinator = new ApprovalCoordinator(
        [wait],
        [session],
        statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
        {
          ...callbacksBuilder().callbacks,
          queueContinuation: async () => scenario.result as ApprovalContinuationDispatchResult,
        } as ApprovalCoordinatorCallbacks,
        { clock },
      );

      await coordinator.tick();
      expect(wait.state).toBe(scenario.expectedState);
      if (scenario.result.status === 'capacity') {
        expect(wait.nextCheckAt).toBe('2026-08-02T18:00:30.000Z');
      }
      if (scenario.result.status === 'denied' && scenario.result.reason === 'session-closed') {
        expect(wait.state).toBe('session-closed');
      }
    }
  });

  it('rejects regex-shaped retry timestamps that do not round-trip canonically', async () => {
    const clock = clockWithState(Date.parse('2026-02-28T23:59:30.000Z'));
    const wait = fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: async () => ({ status: 'capacity', retryAt: '2026-02-29T00:00:00.000Z' }),
      },
      { clock },
    );

    await coordinator.tick();

    expect(wait.state).toBe('resume-reconciliation-required');
  });

  it('does not apply refresh result when lifecycle changes during provider I/O', async () => {
    const clock = clockWithState();
    const status = deferred<NormalizedApprovalStatus>();
    const waits = [fixtureWait({ state: 'pending', nextCheckAt: clock.now(), checkAttempt: 0 })];
    const sessions = [fixtureSession()];
    bindSessionToWait(sessions[0], waits[0]);
    const persist = vi.fn();

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      {
        getStatus: vi.fn(async () => status.promise),
      },
      callbacksBuilder({ persist }).callbacks,
      { clock },
    );

    const tickPromise = coordinator.tick();
    await Promise.resolve();

    sessions[0].lifecycle = 'blocked';
    status.resolve(fixtureStatus({ decision: 'approved' }));
    await tickPromise;

    expect(waits[0].state).toBe('pending');
    expect(waits[0].checkAttempt).toBe(0);
    expect(waits[0].subject).toBe('Restart test service');
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not apply refresh result when canonical waiting summary drifts during provider I/O', async () => {
    const clock = clockWithState();
    const status = deferred<NormalizedApprovalStatus>();
    const waits = [fixtureWait({ state: 'pending', nextCheckAt: clock.now(), checkAttempt: 0 })];
    const sessions = [fixtureSession()];
    bindSessionToWait(sessions[0], waits[0]);
    const persist = vi.fn();

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      {
        getStatus: vi.fn(async () => status.promise),
      },
      callbacksBuilder({ persist }).callbacks,
      { clock },
    );

    const tickPromise = coordinator.tick();
    await Promise.resolve();

    sessions[0].waitingApproval = {
      ...(sessions[0].waitingApproval as WaitingApprovalSummary),
      subject: 'tampered',
    };
    status.resolve(fixtureStatus({ decision: 'approved', subject: 'Approved test service' }));
    await tickPromise;

    expect(waits[0].state).toBe('pending');
    expect(waits[0].checkAttempt).toBe(0);
    expect(waits[0].subject).toBe('Restart test service');
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed dispatch results without executing getters', async () => {
    const clock = clockWithState();
    const wait = fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    let getterExecutions = 0;
    const result: Record<string, unknown> = { runnerRunId: 'runner-1' };
    Object.defineProperty(result, 'status', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterExecutions += 1;
        return 'started';
      },
    });
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: async () => result as ApprovalContinuationDispatchResult,
      },
      { clock },
    );

    await coordinator.tick();

    expect(getterExecutions).toBe(0);
    expect(wait.state).toBe('resume-reconciliation-required');
    expect(wait.runnerRunId).toBeUndefined();
  });

  it('suppresses provider refresh result when closeSessionWait races', async () => {
    const clock = clockWithState();
    const status = deferred<NormalizedApprovalStatus>();
    const sessions = [fixtureSession()];
    const waits = [fixtureWait({ state: 'pending', nextCheckAt: clock.now(), checkAttempt: 0 })];

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      {
        getStatus: vi.fn(() => status.promise),
      },
      callbacksBuilder({ persist: () => { /** noop */ } }).callbacks,
      { clock },
    );

    const tickPromise = coordinator.tick();
    await Promise.resolve();
    await coordinator.closeSessionWait('session-1');
    status.resolve(fixtureStatus({ decision: 'approved' }));
    await tickPromise;

    expect(waits[0].state).toBe('session-closed');
    expect(waits[0].runnerRunId).toBeUndefined();
    expect(sessions[0].lifecycle).toBe('ready');
  });

  it('suppresses dispatch result when closeSessionWait races dispatch', async () => {
    const clock = clockWithState();
    const waits = [fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() })];
    const sessions = [fixtureSession()];
    bindSessionToWait(sessions[0], waits[0]);
    const queueStarted = deferred<void>();
    const gate = deferred<ApprovalContinuationDispatchResult>();
    const persistedStates: string[] = [];

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder({
          persist: () => {
            persistedStates.push(waits[0].state);
          },
        }).callbacks,
        queueContinuation: async () => {
          queueStarted.resolve();
          return gate.promise;
        },
      },
      { clock },
    );

    const tickPromise = coordinator.tick();
    await Promise.resolve();
    await queueStarted.promise;
    await coordinator.closeSessionWait('session-1');
    gate.resolve({ status: 'started', runnerRunId: 'runner-1' });
    await tickPromise;

    expect(waits[0].state).toBe('resume-reconciliation-required');
    expect(waits[0].runnerRunId).toBe('runner-1');
    expect(persistedStates).toEqual([
      'resume-dispatching',
      'session-closed',
      'resume-reconciliation-required',
    ]);
  });

  it('keeps session-closed when close races and callback resolves capacity', async () => {
    const clock = clockWithState();
    const waits = [fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() })];
    const sessions = [fixtureSession()];
    bindSessionToWait(sessions[0], waits[0]);
    const gate = deferred<ApprovalContinuationDispatchResult>();

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder({}).callbacks,
        queueContinuation: async () => gate.promise,
      },
      { clock },
    );

    const tickPromise = coordinator.tick();
    await Promise.resolve();
    await coordinator.closeSessionWait('session-1');
    gate.resolve({ status: 'capacity', retryAt: '2026-08-02T18:00:30.000Z' });
    await tickPromise;

    expect(waits[0].state).toBe('session-closed');
    expect(waits[0].runnerRunId).toBeUndefined();
  });

  it('durably reconciles close races with ambiguous, malformed, thrown, and hostile dispatch results', async () => {
    const scenarios: Array<{ label: string; result: unknown; rejects?: boolean }> = [
      { label: 'ambiguous', result: { status: 'ambiguous' } },
      { label: 'malformed', result: { invalid: 'shape' } },
      { label: 'thrown', result: new Error('dispatcher-failed'), rejects: true },
      {
        label: 'proxy',
        result: new Proxy({}, {
          get: () => {
            throw new Error('hostile-getter');
          },
        }),
      },
    ];

    for (const scenario of scenarios) {
      const clock = clockWithState();
      const waits = [fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now(), id: `wait-${scenario.label}` })];
      const sessions = [fixtureSession()];
      bindSessionToWait(sessions[0], waits[0]);
      const queueStarted = deferred<void>();
      const gate = deferred<unknown>();
      const persistedStates: string[] = [];

      const coordinator = new ApprovalCoordinator(
        waits,
        sessions,
        statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
        {
          ...callbacksBuilder({
            persist: () => {
              persistedStates.push(waits[0].state);
            },
          }).callbacks,
          queueContinuation: async () => {
            queueStarted.resolve();
            return gate.promise as Promise<ApprovalContinuationDispatchResult>;
          },
        },
        { clock },
      );

      const tickPromise = coordinator.tick();
      await Promise.resolve();
      await queueStarted.promise;
      await coordinator.closeSessionWait('session-1');
      if (scenario.rejects) {
        gate.reject(scenario.result);
      } else {
        gate.resolve(scenario.result);
      }
      await tickPromise;

      expect(waits[0].state).toBe('resume-reconciliation-required');
      expect(waits[0].runnerRunId).toBeUndefined();
      expect(persistedStates).toEqual([
        'resume-dispatching',
        'session-closed',
        'resume-reconciliation-required',
      ]);
    }
  });

  it('waits for in-flight registration persistence before allowing close', async () => {
    const clock = clockWithState();
    const waits: ApprovalWaitRecord[] = [];
    const sessions = [fixtureSession()];
    const order: string[] = [];
    const persistGate = deferred<void>();
    const persistStarted = deferred<void>();

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus()]),
      {
        ...callbacksBuilder().callbacks,
        persist: async () => {
          order.push('persist');
          persistStarted.resolve();
          if (order.length === 1) {
            await persistGate.promise;
          }
        },
      },
      { clock },
    );

    const registerPromise = coordinator.register(fixtureCapability(), {
      provider: 'overseer',
      approvalRef: 'admin.roadex.test',
    });
    await persistStarted.promise;

    let closeResolved = false;
    const closePromise = coordinator.closeSessionWait('session-1').then(() => {
      closeResolved = true;
    });
    await Promise.resolve();

    expect(order).toEqual(['persist']);
    expect(closeResolved).toBe(false);

    persistGate.resolve();
    await registerPromise;
    await closePromise;

    expect(order).toEqual(['persist', 'persist']);
    expect(waits).toHaveLength(1);
    expect(waits[0].state).toBe('session-closed');
    expect(closeResolved).toBe(true);
  });

  it('handles pre-queue binding drift to security-failure without queueing continuation', async () => {
    const clock = clockWithState();
    const session = fixtureSession();
    const wait = fixtureWait({
      state: 'approved-resume-queued',
      nextCheckAt: clock.now(),
      sessionId: 'session-1',
    });
    bindSessionToWait(session, wait);

    const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-1' }));
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation,
      },
      { clock },
    );

    session.workspace.id = 'workspace-drift';
    await coordinator.tick();

    expect(wait.state).toBe('security-failure');
    expect(queueContinuation).not.toHaveBeenCalled();
  });

  it('revalidates every live dispatch binding after reservation persistence before queueing', async () => {
    const driftCases: Array<{
      label: string;
      mutate: (session: RoadexSession, waits: ApprovalWaitRecord[]) => void;
      expectPersistCalls?: number;
      expectWaitRemoved?: boolean;
    }> = [
      { label: 'lifecycle', mutate: (session) => { session.lifecycle = 'blocked'; } },
      { label: 'user', mutate: (session) => { session.userId = 'user-drift'; } },
      { label: 'workspace', mutate: (session) => { session.workspace.id = 'workspace-drift'; } },
      { label: 'managed-thread', mutate: (session) => { session.managedThreadId = 'thread-drift'; } },
      { label: 'codex-thread', mutate: (session) => { session.codexThreadId = 'thread-drift'; } },
      {
        label: 'public-summary',
        mutate: (session) => {
          if (session.waitingApproval) {
            session.waitingApproval.subject = 'tampered after reservation';
          }
        },
      },
      {
        label: 'wait-instance',
        mutate: (_session, waits) => {
          waits[0] = { ...waits[0] };
        },
      },
      {
        label: 'wait-removed',
        mutate: (_session, waits) => {
          waits.splice(0, waits.length);
        },
        expectPersistCalls: 2,
        expectWaitRemoved: true,
      },
    ];

    for (const drift of driftCases) {
      const clock = clockWithState();
      const sessionId = `session-post-reserve-${drift.label}`;
      const wait = fixtureWait({
        id: `wait-post-reserve-${drift.label}`,
        sessionId,
        state: 'approved-resume-queued',
        nextCheckAt: clock.now(),
        continuationId: deriveContinuationId(sessionId, 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
      });
      const waits = [wait];
      const session = fixtureSession({ id: sessionId });
      bindSessionToWait(session, wait);
      const persistStarted = deferred<void>();
      const persistGate = deferred<void>();
      let persistCalls = 0;
      const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-1' } as const));
      const coordinator = new ApprovalCoordinator(
        waits,
        [session],
        statusSequenceProvider([]),
        {
          ...callbacksBuilder().callbacks,
          persist: async () => {
            persistCalls += 1;
            if (persistCalls === 1) {
              persistStarted.resolve();
              await persistGate.promise;
            }
          },
          queueContinuation,
        },
        { clock },
      );

      const tickPromise = coordinator.tick();
      await persistStarted.promise;
      drift.mutate(session, waits);
      persistGate.resolve();
      await tickPromise;

      expect(queueContinuation, drift.label).not.toHaveBeenCalled();
      if (drift.expectWaitRemoved) {
        expect(waits, drift.label).toHaveLength(0);
      } else {
        expect(waits[0].state, drift.label).toBe('security-failure');
      }
      expect(persistCalls, drift.label).toBe(drift.expectPersistCalls ?? 2);
    }
  });

  it('requires exact public waiting summary before dispatch, including per-field tamper and extra key', async () => {
    const clock = clockWithState();
    const tamperCases: Array<{ label: string; mutate: (summary: WaitingApprovalSummary & Record<string, unknown>) => void }> = [
      { label: 'waitId', mutate: (summary) => { summary.waitId = 'tampered'; } },
      { label: 'approvalRef', mutate: (summary) => { summary.approvalRef = 'tampered.approval'; } },
      { label: 'subject', mutate: (summary) => { summary.subject = 'tampered subject'; } },
      { label: 'consoleSurface', mutate: (summary) => { summary.consoleSurface = 'overview'; } },
      { label: 'state', mutate: (summary) => { summary.state = 'pending'; } },
      { label: 'updatedAt', mutate: (summary) => { summary.updatedAt = '2026-08-02T00:00:00.000Z'; } },
      {
        label: 'consolePath',
        mutate: (summary) => {
          summary.consolePath = `${summary.consoleSurface}/approvals/${summary.approvalRef}`;
        },
      },
      {
        label: 'extra-key',
        mutate: (summary) => {
          summary.extraneous = 'value';
        },
      },
    ];

    for (const tamper of tamperCases) {
      const wait = fixtureWait({
        state: 'approved-resume-queued',
        id: `wait-${tamper.label}`,
        nextCheckAt: clock.now(),
      });
      const session = fixtureSession({ id: `session-${tamper.label}` });
      wait.sessionId = session.id;
      bindSessionToWait(session, wait);
      const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-1' }));
      const coordinator = new ApprovalCoordinator(
        [wait],
        [session],
        statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
        {
          ...callbacksBuilder().callbacks,
          queueContinuation,
        },
        { clock },
      );

      const original = session.waitingApproval as WaitingApprovalSummary & Record<string, unknown>;
      const mutated = { ...original };
      tamper.mutate(mutated);
      session.waitingApproval = mutated;

      await coordinator.tick();

      expect(queueContinuation).not.toHaveBeenCalled();
      expect(wait.state).toBe('security-failure');
    }
  });

  it('persists pre-queue security-failure before redacted publish and audit', async () => {
    const order: string[] = [];
    const clock = clockWithState();
    const wait = fixtureWait({
      state: 'approved-resume-queued',
      nextCheckAt: clock.now(),
      sessionId: 'session-security-failure',
    });
    const session = fixtureSession({ id: 'session-security-failure' });
    bindSessionToWait(session, wait);

    const published: string[] = [];
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder({
          persist: async () => {
            order.push('persist');
          },
          publish: (_sessionId, message) => {
            order.push('publish');
            published.push(message);
          },
          audit: () => {
            order.push('audit');
          },
        }).callbacks,
      },
      { clock },
    );

    session.waitingApproval = {
      ...session.waitingApproval,
      approvalRef: 'tampered.approval',
    };

    await coordinator.tick();

    expect(order).toEqual(['persist', 'publish', 'audit']);
    expect(published).toEqual(['Roadex human approval result: security-failure']);
    expect(wait.state).toBe('security-failure');
  });

  it('preserves safe runner id and reconciles when binding mutates during callback result', async () => {
    const clock = clockWithState();
    const wait = fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    const queueStarted = deferred<void>();
    const gate = deferred<ApprovalContinuationDispatchResult>();

    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: async () => {
          queueStarted.resolve();
          return gate.promise;
        },
      },
      { clock },
    );

    const tickPromise = coordinator.tick();
    await Promise.resolve();
    await queueStarted.promise;
    session.workspace.id = 'workspace-drift';
    gate.resolve({ status: 'started', runnerRunId: 'runner-1' });
    await tickPromise;

    expect(wait.state).toBe('resume-reconciliation-required');
    expect(wait.runnerRunId).toBe('runner-1');
  });

  it('is awaitable and idempotent under close races', async () => {
    const clock = clockWithState();
    const gate = deferred<void>();
    const waits = [fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() })];
    const sessions = [fixtureSession()];
    bindSessionToWait(sessions[0], waits[0]);
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([]),
      callbacksBuilder({
        persist: async () => {
          await gate.promise;
        },
      }).callbacks,
      { clock },
    );

    const closePromise = coordinator.closeSessionWait('session-1');
    let closed = false;
    void closePromise.then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve();
    await closePromise;
    expect(closed).toBe(true);

    await coordinator.closeSessionWait('session-1');
  });

  it('builds fixed five-line continuation and blocks malformed values', () => {
    const continuation = buildApprovalContinuation(fixtureWait({
      approvalRef: 'admin.roadex.test',
      decisionVersion: `sha256:${'a'.repeat(64)}`,
      subject: 'restart',
    }));

    expect(continuation.split('\n')).toHaveLength(5);
    expect(continuation).toBe(
      [
        '[Roadex verified human approval]',
        'Approval reference: admin.roadex.test',
        `Decision version: sha256:${'a'.repeat(64)}`,
        'Continue the previously paused workflow within the exact approved scope.',
        'Do not broaden the approved operation or infer approval for another gate.',
      ].join('\n'),
    );
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\nroadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\troadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\u0000roadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\u001broadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\u007froadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\u0007roadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
    expect(() => buildApprovalContinuation(fixtureWait({ decisionVersion: 'bad' }))).toThrow(
      /Invalid approval continuation input/,
    );
  });

  it('rejects C1 control characters in approval references', () => {
    expect(() => buildApprovalContinuation(fixtureWait({ approvalRef: 'admin\u0085roadex.test' }))).toThrow(
      /Invalid approval continuation input/,
    );
  });

  it('does not expose mutable fields in registration result or outcome summary', async () => {
    const summary = fixtureSession({
      waitingApproval: {
        waitId: 'unknown',
        approvalRef: 'x',
        subject: 'x',
        consoleSurface: 'admin',
        state: 'pending',
        updatedAt: BASE.toISOString(),
      } as WaitingApprovalSummary,
    });
    const waits: ApprovalWaitRecord[] = [];
    const cb = callbacksBuilder();
    const coordinator = new ApprovalCoordinator(
      waits,
      [summary],
      statusSequenceProvider([fixtureStatus({ decision: 'rejected' })]),
      cb.callbacks,
      { clock: clockWithState() },
    );

    const result = await coordinator.register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });
    expect(result).toMatchObject({ ok: false, code: 'approval-not-pending' });
    expect(cb.audits.every((audit) => !audit.summary.includes('Restart test service'))).toBe(true);
  });

  it('persists successful runner completion before publishing and ignores duplicate completion', async () => {
    const order: string[] = [];
    const wait = fixtureWait({
      state: 'resume-dispatching',
      runnerRunId: 'runner-1',
      dispatchReservedAt: BASE.toISOString(),
      nextCheckAt: BASE.toISOString(),
    });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([]),
      callbacksBuilder({
        persist: () => { order.push(`persist:${wait.state}`); },
        publish: () => { order.push(`publish:${wait.state}`); },
        audit: (action) => { order.push(`audit:${action}`); },
      }).callbacks,
      { clock: clockWithState() },
    );
    const completion = coordinator as ApprovalCoordinator & {
      completeRunner?: (
        continuationId: string,
        runnerRunId: string,
        result: { status: 'succeeded'; managedThreadId: string } | { status: 'failed' },
      ) => Promise<boolean>;
    };

    expect(typeof completion.completeRunner).toBe('function');
    if (!completion.completeRunner) return;
    await expect(completion.completeRunner(wait.continuationId, 'runner-1', {
      status: 'succeeded',
      managedThreadId: 'thread-1',
    })).resolves.toBe(true);

    expect(wait.state).toBe('resumed');
    expect(wait.resumedAt).toBe(BASE.toISOString());
    expect(session.lifecycle).toBe('ready');
    expect(session.waitingApproval).toBeUndefined();
    expect(order).toEqual([
      'persist:resumed',
      'publish:resumed',
      'audit:approval_wait.resume_completed',
    ]);

    order.length = 0;
    await expect(completion.completeRunner(wait.continuationId, 'runner-1', {
      status: 'succeeded',
      managedThreadId: 'thread-1',
    })).resolves.toBe(false);
    expect(order).toEqual([]);
  });

  it.each([
    {
      result: { status: 'succeeded', managedThreadId: 'other-thread' } as const,
      expectedState: 'security-failure' as const,
    },
    {
      result: { status: 'failed' } as const,
      expectedState: 'resume-reconciliation-required' as const,
    },
  ])('fails runner completion closed to $expectedState', async ({ result, expectedState }) => {
    const wait = fixtureWait({
      state: 'resume-dispatching',
      runnerRunId: 'runner-1',
      dispatchReservedAt: BASE.toISOString(),
      nextCheckAt: BASE.toISOString(),
    });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([]),
      callbacksBuilder().callbacks,
      { clock: clockWithState() },
    );
    const completion = coordinator as ApprovalCoordinator & {
      completeRunner?: (
        continuationId: string,
        runnerRunId: string,
        completionResult: typeof result,
      ) => Promise<boolean>;
    };

    expect(typeof completion.completeRunner).toBe('function');
    if (!completion.completeRunner) return;
    await expect(completion.completeRunner(wait.continuationId, 'runner-1', result)).resolves.toBe(true);
    expect(wait.state).toBe(expectedState);
    expect(session.lifecycle).toBe('paused');
  });

  it('reconciles a completed runner on a later tick when completion persistence initially fails', async () => {
    let persistenceAvailable = false;
    const order: string[] = [];
    const wait = fixtureWait({
      state: 'resume-dispatching',
      runnerRunId: 'runner-persist-retry',
      dispatchReservedAt: BASE.toISOString(),
      nextCheckAt: BASE.toISOString(),
    });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    const queueContinuation = vi.fn(async () => ({ status: 'started', runnerRunId: 'duplicate' } as const));
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([]),
      {
        persist: () => {
          order.push(`persist:${wait.state}`);
          if (!persistenceAvailable) throw new Error('temporary persistence outage');
        },
        publish: (_sessionId, message) => { order.push(`publish:${message}`); },
        audit: () => {},
        queueContinuation,
      },
      { clock: clockWithState() },
    );

    await expect(coordinator.completeRunner(wait.continuationId, 'runner-persist-retry', {
      status: 'succeeded',
      managedThreadId: 'thread-1',
    })).resolves.toBe(false);
    expect(wait.state).toBe('resume-dispatching');
    expect(wait.runnerRunId).toBe('runner-persist-retry');

    persistenceAvailable = true;
    order.length = 0;
    await coordinator.tick();

    expect(wait.state).toBe('resume-reconciliation-required');
    expect(wait.runnerRunId).toBeUndefined();
    expect(queueContinuation).not.toHaveBeenCalled();
    expect(order).toEqual([
      'persist:resume-reconciliation-required',
      'publish:Roadex human approval result: resume-reconciliation-required',
    ]);
  });

  it.each([
    ['security-failure', 'security-failure'],
    ['reconciliation-required', 'resume-reconciliation-required'],
  ] as const)('moves an active user-run wait through coordinator %s handling', async (outcome, expectedState) => {
    const wait = fixtureWait({ state: 'pending' });
    const session = fixtureSession();
    bindSessionToWait(session, wait);
    const publish = vi.fn();
    const coordinator = new ApprovalCoordinator(
      [wait],
      [session],
      statusSequenceProvider([]),
      callbacksBuilder({ publish }).callbacks,
      { clock: clockWithState() },
    );

    await expect(coordinator.failUserRun(session.id, outcome)).resolves.toBe(true);

    expect(wait.state).toBe(expectedState);
    expect(session.lifecycle).toBe('paused');
    expect(publish).toHaveBeenCalledWith(
      session.id,
      `Roadex human approval result: ${expectedState}`,
    );
  });

  it('recovers dispatching waits to reconciliation without redispatching queued or pending waits', async () => {
    const dispatching = fixtureWait({
      state: 'resume-dispatching',
      runnerRunId: 'runner-before-restart',
      dispatchReservedAt: BASE.toISOString(),
      nextCheckAt: '2026-08-02T19:00:00.000Z',
    });
    const queued = fixtureWait({
      id: 'wait-2',
      sessionId: 'session-2',
      userId: 'user-2',
      approvalRef: 'admin.roadex.queued',
      state: 'approved-resume-queued',
      continuationId: deriveContinuationId('session-2', 'admin.roadex.queued', `sha256:${'a'.repeat(64)}`),
      nextCheckAt: '2026-08-02T19:00:00.000Z',
    });
    const pending = fixtureWait({
      id: 'wait-3',
      sessionId: 'session-3',
      userId: 'user-3',
      approvalRef: 'admin.roadex.pending',
      state: 'pending',
      continuationId: deriveContinuationId('session-3', 'admin.roadex.pending', `sha256:${'a'.repeat(64)}`),
      nextCheckAt: '2026-08-02T19:00:00.000Z',
    });
    const sessions = [
      fixtureSession({ id: 'session-1', userId: 'user-1' }),
      fixtureSession({ id: 'session-2', userId: 'user-2' }),
      fixtureSession({ id: 'session-3', userId: 'user-3' }),
    ];
    [dispatching, queued, pending].forEach((wait, index) => bindSessionToWait(sessions[index], wait));
    const queue = vi.fn(async () => ({ status: 'started', runnerRunId: 'unexpected' } as const));
    const coordinator = new ApprovalCoordinator(
      [dispatching, queued, pending],
      sessions,
      statusSequenceProvider([]),
      { ...callbacksBuilder().callbacks, queueContinuation: queue },
      { clock: clockWithState() },
    );
    const recovering = coordinator as ApprovalCoordinator & { recover?: () => Promise<void> };

    expect(typeof recovering.recover).toBe('function');
    if (!recovering.recover) return;
    await recovering.recover();

    expect(dispatching.state).toBe('resume-reconciliation-required');
    expect(queued.state).toBe('approved-resume-queued');
    expect(pending.state).toBe('pending');
    expect(queue).not.toHaveBeenCalled();
  });

  it('prevents overlapping ticks from double dispatching', async () => {
    const clock = clockWithState();
    const waits = [fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() })];
    const sessions = [fixtureSession()];
    const queue = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 'started', runnerRunId: 'runner-1' } as const;
    });
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([
        fixtureStatus({ decision: 'approved' }),
        fixtureStatus({ decision: 'approved' }),
        fixtureStatus({ decision: 'approved' }),
      ]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: queue,
      },
      { clock },
    );

    await Promise.all([coordinator.tick(), coordinator.tick(), coordinator.tick()]);
    expect(queue).toHaveBeenCalledTimes(1);
  });
});
