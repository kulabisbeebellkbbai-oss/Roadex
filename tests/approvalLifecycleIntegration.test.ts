import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mockUser } from '../src/server/authService';
import { ApprovalCoordinator } from '../src/server/approvalCoordinator';
import { buildApprovalContinuation } from '../src/server/approvalContinuation';
import {
  createApprovalContinuationDispatcher,
  createApprovalCoordinatorCallbacks,
  createApprovalShutdown,
  createApprovalWorkflowRunRuntime,
  createInitialState,
  closeSession,
  reopenSession,
  resolveApprovalPollMs,
  startApprovalPoller,
  submitPrompt,
} from '../src/server/sessionService';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';
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

function installManagedThread(threadId: string, userId: string, projectRoot: string): () => void {
  const priorRegistry = process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
  const priorUsers = process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
  const registry = join(mkdtempSync(join(tmpdir(), 'roadex-approval-managed-')), 'codex-projects.csv');
  writeFileSync(
    registry,
    `conversation_id,label,project,created_at,updated_at\n${threadId},Approval thread,"${projectRoot}",2026-08-02T18:00:00Z,2026-08-02T18:00:00Z\n`,
  );
  process.env.ROADEX_CODEX_PROJECTS_REGISTRY = registry;
  process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = userId;
  return () => {
    if (priorRegistry === undefined) delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
    else process.env.ROADEX_CODEX_PROJECTS_REGISTRY = priorRegistry;
    if (priorUsers === undefined) delete process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
    else process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = priorUsers;
  };
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
  it('registers from the exact active user run, preserves its paused wait, and later dispatches approval', async () => {
    const managedThreadId = '019f7337-df2e-75c1-b245-5e3588a6c5ac';
    const restoreRegistry = installManagedThread(managedThreadId, mockUser.id, process.cwd());
    const priorControlledRunner = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    try {
    const userRun = deferred<RunnerPromptResult>();
    const continuationRun = deferred<RunnerPromptResult>();
    const requests: RunnerPromptRequest[] = [];
    const runner: SessionRunner = {
      createSession: () => { throw new Error('not used'); },
      runPrompt: (request) => {
        requests.push(request);
        return requests.length === 1 ? userRun.promise : continuationRun.promise;
      },
    };
    const state = createInitialState(runner, { load: emptyPersistedState, save: () => {} });
    const { session } = fixture();
    session.userId = mockUser.id;
    session.workspace = { id: 'roadex', name: 'Roadex', root: process.cwd() };
    session.managedThreadId = managedThreadId;
    session.codexThreadId = managedThreadId;
    session.lifecycle = 'ready';
    delete session.waitingApproval;
    state.sessions.sessions.push(session);
    state.managedThreadClaims.set(session.managedThreadId!, {
      threadId: session.managedThreadId!,
      userId: session.userId,
      claimedAt: NOW,
    });
    state.resolveControlledRunnerGrant = () => ({
      userId: session.userId,
      workspaceId: session.workspace.id,
      workspaceRoot: session.workspace.root,
      managedThreadId: session.managedThreadId!,
      operationId: 'operation-1',
      status: 'active',
    });
    const broker = new ApprovalWorkflowGrantBroker({ now: () => Date.parse(NOW) });
    let runNumber = 0;
    const workflow = createApprovalWorkflowRunRuntime(broker, {
      runIdSource: () => `runner-bound-${runNumber += 1}`,
    });
    state.approvalWorkflowRuntime = workflow;
    let currentNow = NOW;
    const statuses: Array<'pending' | 'approved'> = ['pending', 'approved'];
    const provider = {
      getStatus: async (approvalRef: string) => ({
        provider: 'overseer' as const,
        approvalRef,
        authorityClass: 'privileged-operation' as const,
        decision: statuses.shift()!,
        decisionVersion: `sha256:${'c'.repeat(64)}`,
        projectId: session.workspace.id,
        workspaceId: session.workspace.id,
        resourceRef: 'operation-1',
        subject: 'Approve exact active run',
        updatedAt: currentNow,
      }),
    };
    const coordinatorRef: { current?: ApprovalCoordinator } = {};
    const queueContinuation = createApprovalContinuationDispatcher(state, {
      completeRunner: (...args) => coordinatorRef.current!.completeRunner(...args),
      now: () => currentNow,
    });
    const coordinator = new ApprovalCoordinator(
      state.approvalWaits,
      state.sessions.sessions,
      provider,
      createApprovalCoordinatorCallbacks(state, queueContinuation),
      {
        clock: { now: () => currentNow },
        authorizeStreamingRegistration: (candidate, capability) => (
          state.activeRuns.has(candidate.id)
          && capability.runnerRunId === requests[0]?.runId
          && workflow.resolveRunContext(capability.runnerRunId)?.sessionId === candidate.id
        ),
      },
    );
    coordinatorRef.current = coordinator;

    const submitted = submitPrompt(state, mockUser, session.id, 'perform controlled task');
    expect(submitted, JSON.stringify(state.audit.events.at(-1))).toMatchObject({ accepted: true });
    expect(session.lifecycle).toBe('streaming');
    const issued = broker.consume(requests[0].approvalWorkflowToken!);
    expect(issued?.runId).toBe(requests[0].runId);
    const capability = workflow.resolveRunContext(issued!.runId)!;
    expect(capability.runnerRunId).toBe(issued!.runId);

    const registered = await coordinator.register(capability, {
      provider: 'overseer',
      approvalRef: 'admin.roadex.active-run',
    });
    expect(registered).toMatchObject({ ok: true });
    expect(session.lifecycle).toBe('paused');
    expect(session.waitingApproval?.state).toBe('pending');

    userRun.resolve({ ok: true, events: [], exitCode: 0, codexThreadId: session.managedThreadId });
    await eventually(() => state.activeRuns.size === 0);
    expect(session.lifecycle).toBe('paused');
    expect(session.waitingApproval).toMatchObject({ waitId: state.approvalWaits[0].id, state: 'pending' });

    currentNow = '2026-08-02T18:00:03.000Z';
    await coordinator.tick();
    expect(state.approvalWaits[0].state).toBe('resume-dispatching');
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toBe(buildApprovalContinuation(state.approvalWaits[0]));
    } finally {
      restoreRegistry();
      if (priorControlledRunner === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
      else process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = priorControlledRunner;
    }
  });

  it('retires an active wait on close and creates a freshly revalidated successor on reopen', async () => {
    const managedThreadId = '019f7337-df2e-75c1-b245-5e3588a6c5ad';
    const restoreRegistry = installManagedThread(managedThreadId, mockUser.id, process.cwd());
    try {
      const state = createInitialState({
        createSession: () => { throw new Error('not used'); },
        runPrompt: async () => ({ ok: true, events: [], exitCode: 0, codexThreadId: managedThreadId }),
      }, { load: emptyPersistedState, save: () => {} });
      const { session, wait } = fixture();
      session.userId = mockUser.id;
      session.workspace = { id: 'roadex', name: 'Roadex', root: process.cwd() };
      session.managedThreadId = managedThreadId;
      session.codexThreadId = managedThreadId;
      wait.userId = mockUser.id;
      wait.projectId = 'roadex';
      wait.workspaceId = 'roadex';
      wait.managedThreadId = managedThreadId;
      wait.resourceRef = 'operation-reopen';
      wait.continuationId = continuationId(session.id, wait.approvalRef, wait.decisionVersion);
      session.waitingApproval = {
        waitId: wait.id,
        approvalRef: wait.approvalRef,
        subject: wait.subject,
        consoleSurface: wait.consoleSurface,
        state: wait.state,
        updatedAt: wait.updatedAt,
      };
      state.sessions.sessions.push(session);
      state.approvalWaits.push(wait);
      state.managedThreadClaims.set(managedThreadId, {
        threadId: managedThreadId,
        userId: mockUser.id,
        claimedAt: NOW,
      });
      const coordinator = new ApprovalCoordinator(
        state.approvalWaits,
        state.sessions.sessions,
        {
          getStatus: async () => ({
            provider: 'overseer',
            approvalRef: wait.approvalRef,
            authorityClass: wait.authorityClass,
            decision: 'pending',
            decisionVersion: `sha256:${'d'.repeat(64)}`,
            projectId: wait.projectId,
            workspaceId: wait.workspaceId,
            resourceRef: wait.resourceRef,
            subject: 'Freshly revalidated approval',
            updatedAt: NOW,
          }),
        },
        createApprovalCoordinatorCallbacks(state, async () => ({ status: 'ambiguous' })),
        { clock: { now: () => NOW }, idSource: { generateWaitId: () => 'wait-successor' } },
      );
      state.approvalLifecycleRuntime = {
        closeSessionWait: (sessionId) => coordinator.closeSessionWait(sessionId),
        reopenSessionWait: (sessionId) => coordinator.reopenSessionWait(sessionId),
        failUserRun: (sessionId, outcome) => coordinator.failUserRun(sessionId, outcome),
      };

      await closeSession(state, mockUser, session.id);
      expect(wait.state).toBe('session-closed');
      expect(session.waitingApproval).toBeUndefined();

      const reopened = await reopenSession(state, mockUser, session.id);
      expect(reopened).toMatchObject({ reopened: true, session: { lifecycle: 'paused' } });
      expect(state.approvalWaits).toHaveLength(2);
      expect(state.approvalWaits[0].state).toBe('session-closed');
      expect(state.approvalWaits[1]).toMatchObject({
        id: 'wait-successor',
        state: 'pending',
        decisionVersion: `sha256:${'d'.repeat(64)}`,
      });
      expect(session.waitingApproval?.waitId).toBe('wait-successor');
    } finally {
      restoreRegistry();
    }
  });

  it('rolls back close without aborting the active run when approval-wait persistence fails', async () => {
    const managedThreadId = '019f7337-df2e-75c1-b245-5e3588a6c5af';
    const restoreRegistry = installManagedThread(managedThreadId, mockUser.id, process.cwd());
    try {
      let failPersistence = false;
      const state = createInitialState({
        createSession: () => { throw new Error('not used'); },
        runPrompt: async () => ({ ok: true, events: [], exitCode: 0 }),
      }, {
        load: emptyPersistedState,
        save: () => {
          if (failPersistence) throw new Error('close persistence failed');
        },
      });
      const { session, wait } = fixture();
      session.userId = mockUser.id;
      session.workspace = { id: 'roadex', name: 'Roadex', root: process.cwd() };
      session.managedThreadId = managedThreadId;
      session.codexThreadId = managedThreadId;
      wait.userId = mockUser.id;
      wait.projectId = 'roadex';
      wait.workspaceId = 'roadex';
      wait.managedThreadId = managedThreadId;
      session.waitingApproval = { ...session.waitingApproval!, state: wait.state };
      state.sessions.sessions.push(session);
      state.approvalWaits.push(wait);
      state.managedThreadClaims.set(managedThreadId, {
        threadId: managedThreadId,
        userId: mockUser.id,
        claimedAt: NOW,
      });
      const controller = new AbortController();
      state.activeRuns.set(session.id, controller);
      const coordinator = new ApprovalCoordinator(
        state.approvalWaits,
        state.sessions.sessions,
        { getStatus: async () => { throw new Error('not used'); } },
        createApprovalCoordinatorCallbacks(state, async () => ({ status: 'ambiguous' })),
      );
      state.approvalLifecycleRuntime = {
        closeSessionWait: (sessionId) => coordinator.closeSessionWait(sessionId),
        reopenSessionWait: (sessionId) => coordinator.reopenSessionWait(sessionId),
        failUserRun: (sessionId, outcome) => coordinator.failUserRun(sessionId, outcome),
      };
      failPersistence = true;

      await expect(closeSession(state, mockUser, session.id)).rejects.toThrow('approval_wait_close_persist_failed');
      expect(session.lifecycle).toBe('paused');
      expect(session.waitingApproval?.waitId).toBe(wait.id);
      expect(wait.state).toBe('approved-resume-queued');
      expect(state.activeRuns.get(session.id)).toBe(controller);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      restoreRegistry();
    }
  });

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
      runnerRunId: 'runner-approval-1',
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
