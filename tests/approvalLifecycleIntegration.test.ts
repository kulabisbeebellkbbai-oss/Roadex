import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../src/server/approvalCoordinator';
import { buildApprovalContinuation } from '../src/server/approvalContinuation';
import {
  createApprovalContinuationDispatcher,
  createApprovalCoordinatorCallbacks,
  createApprovalShutdown,
  createApprovalWorkflowRunRuntime,
  createInitialState,
  resolveApprovalPollMs,
  startApprovalPoller,
} from '../src/server/sessionService';
import type { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';
import type { ApprovalWaitRecord } from '../src/shared/approvalWorkflowContracts';
import type { RoadexSession } from '../src/shared/sessionContracts';
import type { RunnerPromptRequest, RunnerPromptResult, SessionRunner } from '../src/server/codexRunner';
import type { PersistedRoadexState, StatePersistence } from '../src/server/statePersistence';

const NOW = '2026-08-02T18:00:00.000Z';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

function continuationId(sessionId: string, approvalRef: string, decisionVersion: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([sessionId, approvalRef, decisionVersion])).digest('hex')}`;
}

function fixture(): { session: RoadexSession; wait: ApprovalWaitRecord } {
  const decisionVersion = `sha256:${'a'.repeat(64)}`;
  const wait: ApprovalWaitRecord = {
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
    subject: 'Approve test operation',
    state: 'approved-resume-queued',
    decisionVersion,
    continuationId: continuationId('session-1', 'admin.roadex.test', decisionVersion),
    checkAttempt: 1,
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    decisionObservedAt: NOW,
  };
  const session: RoadexSession = {
    id: 'session-1',
    userId: 'user-1',
    workspace: { id: 'workspace-1', name: 'Workspace', root: '/workspace/root' },
    lifecycle: 'paused',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: NOW,
    updatedAt: NOW,
    codexThreadId: 'thread-1',
    managedThreadId: 'thread-1',
    waitingApproval: {
      waitId: wait.id,
      approvalRef: wait.approvalRef,
      subject: wait.subject,
      consoleSurface: wait.consoleSurface,
      state: wait.state,
      updatedAt: wait.updatedAt,
    },
  };
  return { session, wait };
}

function emptyPersistedState(): PersistedRoadexState {
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

describe('approval lifecycle integration', () => {
  it('runs one fixed continuation in the exact thread with one grant and persists completion before terminal publication', async () => {
    const run = deferred<RunnerPromptResult>();
    let request: RunnerPromptRequest | undefined;
    const runner: SessionRunner = {
      createSession: () => {
        throw new Error('not used');
      },
      runPrompt: (next) => {
        request = next;
        next.onEvent?.({
          id: 'runner-event',
          sessionId: next.session.id,
          kind: 'assistant',
          message: 'continued safely',
          at: NOW,
        });
        return run.promise;
      },
    };
    const order: string[] = [];
    const persistence: StatePersistence = {
      load: emptyPersistedState,
      save: (snapshot) => {
        const hasTerminal = snapshot.streamEvents.some(
          (event) => event.message === 'Roadex human approval result: resumed',
        );
        order.push(hasTerminal ? 'publish-save' : `persist:${snapshot.approvalWaits[0]?.state ?? 'none'}`);
      },
    };
    const state = createInitialState(runner, persistence);
    const { session, wait } = fixture();
    state.sessions.sessions.push(session);
    state.approvalWaits.push(wait);
    const issue = vi.fn((input) => ({
      ...input,
      token: 'A'.repeat(43),
      expiresAt: '2026-08-02T18:05:00.000Z',
    }));
    const revokeRun = vi.fn();
    const broker = { issue, revokeRun } as unknown as Pick<ApprovalWorkflowGrantBroker, 'issue' | 'revokeRun'>;
    const workflow = createApprovalWorkflowRunRuntime(broker, {
      runIdSource: () => 'runner-approval-1',
    });
    state.approvalWorkflowRuntime = workflow;
    state.resolveControlledRunnerGrant = () => ({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace/root',
      managedThreadId: 'thread-1',
      operationId: 'operation-1',
      status: 'active',
    });

    const coordinatorRef: { current?: ApprovalCoordinator } = {};
    const queueContinuation = createApprovalContinuationDispatcher(state, {
      completeRunner: (...args) => {
        if (!coordinatorRef.current) throw new Error('coordinator unavailable');
        return coordinatorRef.current.completeRunner(...args);
      },
    });
    const coordinator = new ApprovalCoordinator(
      state.approvalWaits,
      state.sessions.sessions,
      { getStatus: async () => { throw new Error('not used'); } },
      createApprovalCoordinatorCallbacks(state, queueContinuation),
      { clock: { now: () => NOW } },
    );
    coordinatorRef.current = coordinator;

    await coordinator.tick();

    expect(wait.state).toBe('resume-dispatching');
    expect(wait.runnerRunId).toBe('runner-approval-1');
    expect(request).toMatchObject({
      session: expect.objectContaining({
        id: 'session-1',
        userId: 'user-1',
        codexThreadId: 'thread-1',
        managedThreadId: 'thread-1',
      }),
      prompt: buildApprovalContinuation(wait),
      approvalWorkflowToken: 'A'.repeat(43),
      runId: 'runner-approval-1',
      capabilityGrant: expect.objectContaining({
        userId: 'user-1',
        workspaceId: 'workspace-1',
        managedThreadId: 'thread-1',
      }),
    });
    expect(issue).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      managedThreadId: 'thread-1',
      runId: 'runner-approval-1',
    });
    expect(workflow.resolveRunContext('runner-approval-1')).toEqual({
      sessionId: 'session-1',
      userId: 'user-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      resourceRef: 'resource.one',
      managedThreadId: 'thread-1',
    });
    expect(state.sessions.streamEvents.some((event) => event.kind === 'user')).toBe(false);

    order.length = 0;
    run.resolve({ ok: true, events: [], exitCode: 0, codexThreadId: 'thread-1' });
    await eventually(() => wait.state === 'resumed');

    expect(revokeRun).toHaveBeenCalledTimes(1);
    expect(revokeRun).toHaveBeenCalledWith('runner-approval-1');
    expect(workflow.resolveRunContext('runner-approval-1')).toBeUndefined();
    expect(order.indexOf('persist:resumed')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('publish-save')).toBeGreaterThan(order.indexOf('persist:resumed'));
    expect(state.audit.events).toContainEqual(expect.objectContaining({
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.resume_completed',
      outcome: 'allowed',
    }));

    await coordinator.tick();
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('holds an immediately resolved runner completion until the started dispatch is persisted', async () => {
    const persisted: string[] = [];
    const runner: SessionRunner = {
      createSession: () => {
        throw new Error('not used');
      },
      runPrompt: async () => ({
        ok: true,
        events: [],
        exitCode: 0,
        codexThreadId: 'thread-1',
      }),
    };
    const state = createInitialState(runner, {
      load: emptyPersistedState,
      save: (snapshot) => {
        const savedWait = snapshot.approvalWaits[0];
        persisted.push(`${savedWait?.state ?? 'none'}:${savedWait?.runnerRunId ?? 'none'}`);
      },
    });
    const { session, wait } = fixture();
    state.sessions.sessions.push(session);
    state.approvalWaits.push(wait);
    state.resolveControlledRunnerGrant = () => ({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace/root',
      managedThreadId: 'thread-1',
      operationId: 'operation-1',
      status: 'active',
    });
    const revokeRun = vi.fn();
    state.approvalWorkflowRuntime = createApprovalWorkflowRunRuntime({
      issue: (input) => ({ ...input, token: 'A'.repeat(43), expiresAt: '2026-08-02T18:05:00.000Z' }),
      revokeRun,
    } as unknown as Pick<ApprovalWorkflowGrantBroker, 'issue' | 'revokeRun'>, {
      runIdSource: () => 'runner-immediate-1',
    });

    const coordinatorRef: { current?: ApprovalCoordinator } = {};
    const queueContinuation = createApprovalContinuationDispatcher(state, {
      completeRunner: (...args) => {
        if (!coordinatorRef.current) throw new Error('coordinator unavailable');
        return coordinatorRef.current.completeRunner(...args);
      },
      now: () => NOW,
    });
    const coordinator = new ApprovalCoordinator(
      state.approvalWaits,
      state.sessions.sessions,
      { getStatus: async () => { throw new Error('not used'); } },
      createApprovalCoordinatorCallbacks(state, queueContinuation),
      { clock: { now: () => NOW } },
    );
    coordinatorRef.current = coordinator;

    await coordinator.tick();
    await eventually(() => wait.state === 'resumed');

    expect(persisted).toContain('resume-dispatching:runner-immediate-1');
    expect(persisted.indexOf('resumed:none')).toBeGreaterThan(
      persisted.indexOf('resume-dispatching:runner-immediate-1'),
    );
    expect(revokeRun).toHaveBeenCalledExactlyOnceWith('runner-immediate-1');
  });

  it('uses an unref poller and performs idempotent ordered shutdown', async () => {
    const tick = vi.fn(async () => {});
    let scheduled: (() => void) | undefined;
    const unref = vi.fn();
    const poller = startApprovalPoller(
      { tick },
      resolveApprovalPollMs(undefined),
      (callback, intervalMs) => {
        expect(intervalMs).toBe(2_000);
        scheduled = callback;
        return { unref };
      },
    );

    expect(poller).toBeDefined();
    expect(unref).toHaveBeenCalledTimes(1);
    scheduled?.();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(resolveApprovalPollMs('invalid')).toBe(2_000);

    const shutdownOrder: string[] = [];
    const shutdown = createApprovalShutdown({
      stopPolling: () => { shutdownOrder.push('poll'); },
      closeWorkflowHost: async () => { shutdownOrder.push('socket'); },
      revokeOutstandingGrants: () => { shutdownOrder.push('grants'); },
      closeHttpServer: async () => { shutdownOrder.push('http'); },
    });

    await Promise.all([shutdown(), shutdown()]);
    expect(shutdownOrder).toEqual(['poll', 'socket', 'grants', 'http']);
  });

  it('revokes the one-run grant when dispatch setup fails before the runner starts', async () => {
    const runner = {
      createSession: () => { throw new Error('not used'); },
      runPrompt: vi.fn(() => Promise.reject(new Error('must not start'))),
    } satisfies SessionRunner;
    const state = createInitialState(runner, {
      load: emptyPersistedState,
      save: () => { throw new Error('injected persistence failure'); },
    });
    const { session, wait } = fixture();
    wait.state = 'resume-dispatching';
    session.waitingApproval = { ...session.waitingApproval!, state: 'resume-dispatching' };
    state.sessions.sessions.push(session);
    state.approvalWaits.push(wait);
    state.resolveControlledRunnerGrant = () => ({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace/root',
      managedThreadId: 'thread-1',
      operationId: 'operation-1',
      status: 'active',
    });
    const revokeRun = vi.fn();
    const workflow = createApprovalWorkflowRunRuntime({
      issue: (input) => ({ ...input, token: 'A'.repeat(43), expiresAt: '2026-08-02T18:05:00.000Z' }),
      revokeRun,
    } as unknown as Pick<ApprovalWorkflowGrantBroker, 'issue' | 'revokeRun'>, {
      runIdSource: () => 'runner-setup-failure',
    });
    state.approvalWorkflowRuntime = workflow;
    const dispatch = createApprovalContinuationDispatcher(state, {
      completeRunner: vi.fn(async () => false),
      now: () => NOW,
    });

    await expect(dispatch(wait, buildApprovalContinuation(wait))).resolves.toEqual({ status: 'ambiguous' });
    expect(runner.runPrompt).not.toHaveBeenCalled();
    expect(revokeRun).toHaveBeenCalledExactlyOnceWith('runner-setup-failure');
    expect(workflow.resolveRunContext('runner-setup-failure')).toBeUndefined();
    expect(state.activeRuns.size).toBe(0);
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition_not_met');
}
