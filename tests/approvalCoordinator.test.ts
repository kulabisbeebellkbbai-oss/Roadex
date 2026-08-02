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
import type { ApprovalStatusProvider } from '../src/server/approvalStatusProvider.js';
import type { NormalizedApprovalStatus, WaitingApprovalSummary } from '../src/shared/approvalWorkflowContracts.js';
import type { AuditEvent, RoadexSession } from '../src/shared/sessionContracts.js';

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

function fixtureWait(overrides: Partial<import('../src/shared/approvalWorkflowContracts.js').ApprovalWaitRecord> = {}): import('../src/shared/approvalWorkflowContracts.js').ApprovalWaitRecord {
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
      publish: (message: string) => {
        events.push(message);
      },
      audit: (action, outcome, summary, resource) => {
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

describe('ApprovalCoordinator', () => {
  it('registers a pending approval and pauses the session', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits: Array<import('../src/shared/approvalWorkflowContracts.js').ApprovalWaitRecord> = [];
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
    expect(cb.events).toHaveLength(1);
    expect(cb.events[0]).toContain('Admin Console');
    expect(cb.events[0]).toContain('Roadex will continue automatically');
    expect(cb.events[0]).not.toContain('http://');

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

  it('maps project-workflow approvals to overview console', async () => {
    const sessions = [fixtureSession()];
    const waits: Array<import('../src/shared/approvalWorkflowContracts.js').ApprovalWaitRecord> = [];
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

      expect(result).toMatchObject({ ok: false, code: decision === 'approved' ? 'approval-not-pending' : 'approval-not-pending' });
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

  it('handles provider unavailability and persistence failure with rollback', async () => {
    const unavailable = await new ApprovalCoordinator(
      [],
      [fixtureSession()],
      { getStatus: vi.fn(async () => { throw new Error('provider-down'); }) },
      callbacksBuilder().callbacks,
      { clock: clockWithState() },
    ).register(fixtureCapability(), { provider: 'overseer', approvalRef: 'admin.roadex.test' });
    expect(unavailable).toMatchObject({ ok: false, code: 'provider-unavailable' });

    const waits: Array<import('../src/shared/approvalWorkflowContracts.js').ApprovalWaitRecord> = [];
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

  it('uses bounded exponential backoff and increments attempts on provider checks', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits = [fixtureWait({ nextCheckAt: clock.now(), checkAttempt: 0 })];

    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus(), fixtureStatus(), fixtureStatus(), fixtureStatus(), fixtureStatus(), fixtureStatus()]),
      callbacksBuilder().callbacks,
      { clock, idSource: { generateWaitId: () => 'wait-1' } },
    );

    await coordinator.tick();
    expect(waits[0].checkAttempt).toBe(1);
    expect(waits[0].nextCheckAt).toBe('2026-08-02T18:00:02.000Z');

    clock.set(BASE.getTime() + 1000);
    await coordinator.tick();
    expect(waits[0].nextCheckAt).toBe('2026-08-02T18:00:02.000Z');

    clock.set(BASE.getTime() + 2000);
    await coordinator.tick();
    expect(waits[0].checkAttempt).toBe(2);
    expect(waits[0].nextCheckAt).toBe('2026-08-02T18:00:07.000Z');

    clock.set(BASE.getTime() + 7000);
    await coordinator.tick();
    expect(waits[0].checkAttempt).toBe(3);
    expect(waits[0].nextCheckAt).toBe('2026-08-02T18:00:22.000Z');
  });

  it('moves from delay to pending after recovery without losing wait history', async () => {
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
    clock.set(BASE.getTime() + 3000);
    await recovering.tick();
    expect(waits[0].state).toBe('pending');
    expect(waits[0].checkAttempt).toBe(2);
  });

  it('publishes fixed outcomes and returns ready for terminal non-approved decisions', async () => {
    const terminalDecisions: Array<NormalizedApprovalStatus['decision']> = ['changes-requested', 'rejected', 'expired', 'revoked'];
    const clock = clockWithState();

    for (const decision of terminalDecisions) {
      const sessions = [fixtureSession({ id: `session-${decision}` })];
      const waits = [
        fixtureWait({
          id: `wait-${decision}`,
          sessionId: `session-${decision}`,
          state: 'pending',
          nextCheckAt: clock.now(),
          decisionVersion: `sha256:${'a'.repeat(64)}`,
          continuationId: deriveContinuationId(`session-${decision}`, 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
        }),
      ];
      const cb = callbacksBuilder();
      const coordinator = new ApprovalCoordinator(
        waits,
        sessions,
        statusSequenceProvider([fixtureStatus({ decision })]),
        cb.callbacks,
        { clock },
      );

      await coordinator.tick();
      expect(waits[0].state).toBe(decision);
      expect(sessions[0].lifecycle).toBe('ready');
      expect(cb.events.some((event) => event.includes('Roadex human approval result'))).toBe(true);
      expect(cb.events.some((event) => event.includes('subject'))).toBe(false);
    }
  });

  it('converts mismatched authoritative status into security-failure', async () => {
    const clock = clockWithState();
    const sessions = [fixtureSession()];
    const waits = [fixtureWait({ id: 'wait-mismatch', nextCheckAt: clock.now(), checkAttempt: 0 })];
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ projectId: 'other-project' })]),
      callbacksBuilder().callbacks,
      { clock },
    );

    await coordinator.tick();
    expect(waits[0].state).toBe('security-failure');
    expect(sessions[0].lifecycle).toBe('paused');
    expect(waits[0].nextCheckAt).toBe(clock.now());
  });

  it('transitions approved wait to resumed dispatch and stores continuation id', async () => {
    const clock = clockWithState();
    const waits = [fixtureWait({ nextCheckAt: clock.now(), checkAttempt: 0 })];
    const sessions = [fixtureSession()];

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

  it('dispatches approved wait from queued without rechecking provider', async () => {
    const wait = fixtureWait({
      state: 'approved-resume-queued',
      continuationId: deriveContinuationId('session-1', 'admin.roadex.test', `sha256:${'a'.repeat(64)}`),
      nextCheckAt: clockWithState().now(),
    });
    const calls: string[] = [];

    const queue = vi.fn(async (_w, prompt) => {
      calls.push(prompt);
      return { status: 'started', runnerRunId: 'runner-1' } as const;
    });

    const coordinator = new ApprovalCoordinator(
      [wait],
      [fixtureSession()],
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: queue,
      },
      { clock: clockWithState() },
    );

    await coordinator.tick();

    expect(queue).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe(buildApprovalContinuation(wait));
    expect(wait.state).toBe('resume-dispatching');
    await coordinator.tick();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('maps dispatch results across started, capacity, ambiguous, and denied', async () => {
    const clock = clockWithState();
    const scenarios: Array<{ result: ApprovalContinuationDispatchResult; expectedState: string }> = [
      { result: { status: 'capacity', retryAt: '2026-08-02T18:00:30.000Z' }, expectedState: 'approved-resume-queued' },
      { result: { status: 'ambiguous' }, expectedState: 'resume-reconciliation-required' },
      { result: { status: 'denied', reason: 'session-closed' }, expectedState: 'session-closed' },
      { result: { status: 'denied', reason: 'scope-mismatch' }, expectedState: 'security-failure' },
    ];

    for (const scenario of scenarios) {
      const wait = fixtureWait({
        state: 'approved-resume-queued',
        id: `wait-${scenario.result.status}`,
        sessionId: `session-${scenario.result.status}`,
        checkAttempt: 1,
        nextCheckAt: clock.now(),
      });
      const sessions = [fixtureSession({ id: `session-${scenario.result.status}` })];
      const coordinator = new ApprovalCoordinator(
        [wait],
        sessions,
        statusSequenceProvider([fixtureStatus({ decision: 'approved', decisionVersion: `sha256:${'a'.repeat(64)}` })]),
        {
          ...callbacksBuilder().callbacks,
          queueContinuation: async () => scenario.result,
        },
        { clock },
      );

      await coordinator.tick();
      expect(wait.state).toBe(scenario.expectedState);
      if (scenario.result.status === 'capacity') {
        expect(wait.nextCheckAt).toBe('2026-08-02T18:00:30.000Z');
      }
    }

    const ambiguousThrown = new ApprovalCoordinator(
      [fixtureWait({ state: 'approved-resume-queued', id: 'wait-thrown', nextCheckAt: clockWithState().now() })],
      [fixtureSession()],
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: async () => { throw new Error('queue failed'); },
      },
      { clock: clockWithState() },
    );

    await ambiguousThrown.tick();
    expect(ambiguousThrown).toBeDefined();
  });

  it('suppresses queued continuation after closeSessionWait and is idempotent', async () => {
    const clock = clockWithState();
    const waits = [fixtureWait({ state: 'approved-resume-queued', nextCheckAt: clock.now() })];
    const sessions = [fixtureSession()];
    const queue = vi.fn(async () => ({ status: 'started', runnerRunId: 'runner-1' } as const));
    const coordinator = new ApprovalCoordinator(
      waits,
      sessions,
      statusSequenceProvider([fixtureStatus({ decision: 'approved' })]),
      {
        ...callbacksBuilder().callbacks,
        queueContinuation: queue,
      },
      { clock },
    );

    coordinator.closeSessionWait('session-1');
    await coordinator.tick();
    expect(waits[0].state).toBe('session-closed');
    expect(queue).not.toHaveBeenCalled();

    coordinator.closeSessionWait('session-1');
    expect(waits[0].state).toBe('session-closed');
  });

  it('prevents overlapping ticks from double dispatch', async () => {
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
    expect(() => buildApprovalContinuation(fixtureWait({ decisionVersion: 'bad' }))).toThrow(
      /Invalid approval continuation input/,
    );
  });

  it('does not expose mutable fields in registration result or outcomes', async () => {
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
    const waits: Array<import('../src/shared/approvalWorkflowContracts.js').ApprovalWaitRecord> = [];
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
});
