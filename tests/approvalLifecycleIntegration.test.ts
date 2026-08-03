import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockUser } from '../src/server/authService';
import {
  createInitialState,
  bootstrap,
  createSessionFromApi,
  dispatchApprovalContinuation,
  resolveActiveApprovalRunCapability,
  submitPrompt,
  type ApprovalLifecycleBridge,
} from '../src/server/sessionService';
import { createMemoryPersistence } from '../src/server/statePersistence';
import { buildApprovalContinuation } from '../src/server/approvalContinuation';
import {
  ApprovalCoordinator,
  type ApprovalContinuationCompletionOutcome,
} from '../src/server/approvalCoordinator';
import type { RunnerPromptRequest, RunnerPromptResult, SessionRunner } from '../src/server/codexRunner';
import type { ApprovalWaitRecord } from '../src/shared/approvalWorkflowContracts';
import type { RoadexSession } from '../src/shared/sessionContracts';

const NOW = '2026-08-02T18:00:00.000Z';

function session(): RoadexSession {
  return {
    id: 'session-approval-1',
    userId: mockUser.id,
    workspace: { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
    lifecycle: 'paused',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: NOW,
    updatedAt: NOW,
    managedThreadId: 'managed-thread-1',
    codexThreadId: 'managed-thread-1',
  };
}

function waitFor(target: RoadexSession, overrides: Partial<ApprovalWaitRecord> = {}): ApprovalWaitRecord {
  const record: ApprovalWaitRecord = {
    id: 'wait-approval-1',
    sessionId: target.id,
    userId: target.userId,
    projectId: target.workspace.id,
    workspaceId: target.workspace.id,
    managedThreadId: target.managedThreadId!,
    provider: 'overseer',
    approvalRef: 'admin.approval-1',
    resourceRef: 'resource.approval-1',
    authorityClass: 'privileged-operation',
    consoleSurface: 'admin',
    subject: 'Resume the approved workflow',
    state: 'resume-dispatching',
    decisionVersion: `sha256:${'1'.repeat(64)}`,
    continuationId: `sha256:${'2'.repeat(64)}`,
    checkAttempt: 1,
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    decisionObservedAt: NOW,
    dispatchReservedAt: NOW,
    ...overrides,
  };
  if (overrides.continuationId === undefined) {
    record.continuationId = `sha256:${createHash('sha256')
      .update(JSON.stringify([record.sessionId, record.approvalRef, record.decisionVersion]))
      .digest('hex')}`;
  }
  return record;
}

function projectWait(target: RoadexSession, wait: ApprovalWaitRecord): void {
  target.waitingApproval = {
    waitId: wait.id,
    approvalRef: wait.approvalRef,
    subject: wait.subject,
    consoleSurface: wait.consoleSurface,
    state: wait.state as NonNullable<RoadexSession['waitingApproval']>['state'],
    updatedAt: wait.updatedAt,
  };
}

function runnerWithGate() {
  let settle!: (result: RunnerPromptResult) => void;
  let sessions = 0;
  const runPromise = new Promise<RunnerPromptResult>((resolve) => { settle = resolve; });
  const requests: RunnerPromptRequest[] = [];
  const runner: SessionRunner = {
    createSession({ userId, workspace }) {
      sessions += 1;
      const created = session();
      created.id = `session-gated-${sessions}`;
      created.userId = userId;
      created.workspace = workspace;
      created.lifecycle = 'ready';
      delete created.managedThreadId;
      delete created.codexThreadId;
      return created;
    },
    runPrompt(request) {
      requests.push(request);
      return runPromise;
    },
  };
  return { runner, requests, settle };
}

function attachBridge(
  state: ReturnType<typeof createInitialState>,
  complete: ApprovalLifecycleBridge['completeContinuation'] = async () => undefined,
) {
  const issued: Array<{ runId: string; token: string }> = [];
  const revoked: string[] = [];
  state.approvalLifecycle = {
    hasActiveWait: (sessionId) => state.approvalWaits.some((wait) => wait.sessionId === sessionId),
    issueWorkflowGrant(scope) {
      const token = `workflow-${scope.runId}`;
      issued.push({ runId: scope.runId, token });
      return token;
    },
    revokeWorkflowGrant(runId) {
      revoked.push(runId);
    },
    completeContinuation: complete,
  };
  return { issued, revoked };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('approval continuation lifecycle integration', () => {
  it('pauses a streaming controlled user run for approval and later dispatches the fixed continuation', async () => {
    const originalRegistry = process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
    const originalAuthorizedUsers = process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
    const registry = join(mkdtempSync(join(tmpdir(), 'roadex-streaming-approval-')), 'codex-projects.csv');
    const managedThreadId = '019f7337-df2e-75c1-b245-5e3588a6c5ab';
    writeFileSync(
      registry,
      `conversation_id,label,project,created_at,updated_at\n${managedThreadId},Managed thread,"${process.cwd()}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z\n`,
    );
    process.env.ROADEX_CODEX_PROJECTS_REGISTRY = registry;
    process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = mockUser.id;
    try {
      const controlled = runnerWithGate();
      const state = createInitialState(controlled.runner, createMemoryPersistence());
      const managed = (await bootstrap(state, mockUser)).managedThreads.find((thread) => thread.id === managedThreadId);
      expect(managed).toBeDefined();
      if (!managed) return;
      const created = await createSessionFromApi(state, mockUser, {
        workspaceId: managed.project.id,
        managedThreadId,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const resourceRef = 'admin.streaming-controlled-operation';
      state.resolveControlledRunnerGrant = () => ({
        userId: mockUser.id,
        workspaceId: created.session.workspace.id,
        workspaceRoot: created.session.workspace.root,
        managedThreadId,
        operationId: resourceRef,
        status: 'active',
      });
      state.approvalLifecycle.issueWorkflowGrant = ({ runId }) => `workflow-${runId}`;

      expect(submitPrompt(state, mockUser, created.session.id, 'start approval-gated work'))
        .toMatchObject({ accepted: true });
      const originalRequest = controlled.requests[0];
      const capability = resolveActiveApprovalRunCapability(state, originalRequest.runId!);
      expect(capability).toBeDefined();
      expect(created.session.lifecycle).toBe('streaming');

      let now = '2026-08-02T19:00:00.000Z';
      let status = {
        provider: 'overseer' as const,
        approvalRef: 'admin.streaming-approval',
        authorityClass: 'privileged-operation' as const,
        decision: 'pending' as const,
        decisionVersion: `sha256:${'5'.repeat(64)}`,
        projectId: created.session.workspace.id,
        workspaceId: created.session.workspace.id,
        resourceRef,
        subject: 'Approve streaming workflow continuation',
        updatedAt: now,
      };
      const order: string[] = [];
      const coordinator = new ApprovalCoordinator(
        state.approvalWaits,
        state.sessions.sessions,
        { getStatus: async () => status },
        {
          persist: () => { order.push('persist'); },
          publish: () => { order.push('publish'); },
          audit: vi.fn(),
          queueContinuation: (wait, prompt) => dispatchApprovalContinuation(state, wait, prompt),
        },
        { clock: { now: () => now }, backoffJitter: () => 0 },
      );
      state.approvalLifecycle.hasActiveWait = (sessionId) => coordinator.hasActiveWait(sessionId);
      state.approvalLifecycle.completeContinuation = (...args) => coordinator.completeContinuation(...args);

      const registered = await coordinator.register(capability!, {
        provider: 'overseer',
        approvalRef: status.approvalRef,
      });
      expect(registered.ok).toBe(true);
      expect(order.slice(0, 2)).toEqual(['persist', 'publish']);
      expect(created.session).toMatchObject({
        lifecycle: 'paused',
        waitingApproval: {
          waitId: state.approvalWaits[0].id,
          state: 'pending',
          approvalRef: status.approvalRef,
        },
      });

      controlled.settle({ ok: true, events: [], exitCode: 0, codexThreadId: managedThreadId });
      await flushImmediate();
      expect(created.session.lifecycle).toBe('paused');
      expect(created.session.runActivity).toBeUndefined();
      expect(created.session.waitingApproval).toMatchObject({
        waitId: state.approvalWaits[0].id,
        state: 'pending',
      });

      now = '2026-08-02T19:00:03.000Z';
      status = {
        ...status,
        decision: 'approved',
        decisionVersion: `sha256:${'6'.repeat(64)}`,
        updatedAt: now,
      };
      await coordinator.tick();

      expect(controlled.requests).toHaveLength(2);
      expect(controlled.requests[1]).toMatchObject({
        prompt: buildApprovalContinuation(state.approvalWaits[0]),
        runId: state.approvalWaits[0].runnerRunId,
        session: { lifecycle: 'paused', managedThreadId },
      });
      expect(controlled.requests[1].prompt).not.toBe('start approval-gated work');
    } finally {
      if (originalRegistry === undefined) delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
      else process.env.ROADEX_CODEX_PROJECTS_REGISTRY = originalRegistry;
      if (originalAuthorizedUsers === undefined) delete process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
      else process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = originalAuthorizedUsers;
    }
  });

  it('authorizes approval workflow access only for an exact controlled managed user run and cleans it up', async () => {
    const originalRegistry = process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
    const originalAuthorizedUsers = process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
    const registry = join(mkdtempSync(join(tmpdir(), 'roadex-approval-user-run-')), 'codex-projects.csv');
    const managedThreadId = '019f7337-df2e-75c1-b245-5e3588a6c5aa';
    writeFileSync(
      registry,
      `conversation_id,label,project,created_at,updated_at\n${managedThreadId},Managed thread,"${process.cwd()}",2026-07-17T00:00:00Z,2026-07-18T00:00:00Z\n`,
    );
    process.env.ROADEX_CODEX_PROJECTS_REGISTRY = registry;
    process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = mockUser.id;
    try {
      const controlled = runnerWithGate();
      const persistence = createMemoryPersistence();
      const state = createInitialState(controlled.runner, persistence);
      const managed = (await bootstrap(state, mockUser)).managedThreads.find((thread) => thread.id === managedThreadId);
      expect(managed).toBeDefined();
      if (!managed) return;
      const created = await createSessionFromApi(state, mockUser, {
        workspaceId: managed.project.id,
        managedThreadId,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const grant = {
        userId: mockUser.id,
        workspaceId: created.session.workspace.id,
        workspaceRoot: created.session.workspace.root,
        managedThreadId,
        operationId: 'admin.operation-controlled-user',
        status: 'active' as const,
      };
      state.resolveControlledRunnerGrant = () => grant;
      const secretToken = 'workflow_secret_token_must_not_leak_12345';
      const revoked: string[] = [];
      state.approvalLifecycle.issueWorkflowGrant = () => secretToken;
      state.approvalLifecycle.revokeWorkflowGrant = (runId) => revoked.push(runId);

      expect(submitPrompt(state, mockUser, created.session.id, 'controlled managed prompt'))
        .toMatchObject({ accepted: true });

      const request = controlled.requests[0];
      expect(request.runId).toMatch(/^run-[0-9a-f]{32}$/);
      expect(request.approvalWorkflowToken).toBe(secretToken);
      expect(resolveActiveApprovalRunCapability(state, request.runId!)).toEqual({
        sessionId: created.session.id,
        userId: mockUser.id,
        projectId: created.session.workspace.id,
        workspaceId: created.session.workspace.id,
        resourceRef: grant.operationId,
        managedThreadId,
      });
      expect(JSON.stringify(state.audit.events)).not.toContain(secretToken);
      expect(JSON.stringify(persistence.load())).not.toContain(secretToken);

      controlled.settle({ ok: true, events: [], exitCode: 0, codexThreadId: managedThreadId });
      await flushImmediate();
      expect(resolveActiveApprovalRunCapability(state, request.runId!)).toBeUndefined();
      expect(revoked).toEqual([request.runId]);

      const restrictedRequests: RunnerPromptRequest[] = [];
      const restrictedState = createInitialState({
        createSession: ({ userId, workspace }) => {
          const created = session();
          created.id = 'session-restricted-unmanaged';
          created.userId = userId;
          created.workspace = workspace;
          created.lifecycle = 'ready';
          delete created.managedThreadId;
          delete created.codexThreadId;
          return created;
        },
        async runPrompt(request) {
          restrictedRequests.push(request);
          return { ok: true, events: [], exitCode: 0 };
        },
      }, createMemoryPersistence());
      const unmanaged = await createSessionFromApi(restrictedState, mockUser, { workspaceId: 'roadex' });
      expect(unmanaged.ok).toBe(true);
      if (!unmanaged.ok) return;
      restrictedState.resolveControlledRunnerGrant = () => grant;
      restrictedState.approvalLifecycle.issueWorkflowGrant = vi.fn(() => secretToken);
      expect(submitPrompt(restrictedState, mockUser, unmanaged.session.id, 'restricted unmanaged prompt'))
        .toMatchObject({ accepted: true });
      expect(restrictedRequests[0]).toMatchObject({
        approvalWorkflowToken: undefined,
        runId: undefined,
      });
      expect(restrictedState.approvalLifecycle.issueWorkflowGrant).not.toHaveBeenCalled();
    } finally {
      if (originalRegistry === undefined) delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
      else process.env.ROADEX_CODEX_PROJECTS_REGISTRY = originalRegistry;
      if (originalAuthorizedUsers === undefined) delete process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;
      else process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS = originalAuthorizedUsers;
    }
  });

  it('dispatches only the fixed coordinator continuation with exact run binding and cleans up grants', async () => {
    const controlled = runnerWithGate();
    const state = createInitialState(controlled.runner, createMemoryPersistence());
    const target = session();
    const wait = waitFor(target);
    projectWait(target, wait);
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    const completed = vi.fn(async () => undefined);
    const lifecycle = attachBridge(state, completed);
    const prompt = buildApprovalContinuation(wait);

    const result = await dispatchApprovalContinuation(state, wait, prompt);

    expect(result.status).toBe('started');
    if (result.status !== 'started') return;
    expect(result.runnerRunId).toMatch(/^run-[0-9a-f]{32}$/);
    expect(controlled.requests).toHaveLength(1);
    expect(controlled.requests[0]).toMatchObject({
      prompt,
      runId: result.runnerRunId,
      approvalWorkflowToken: `workflow-${result.runnerRunId}`,
      session: { lifecycle: 'paused', managedThreadId: wait.managedThreadId },
    });
    expect(resolveActiveApprovalRunCapability(state, result.runnerRunId)).toEqual({
      sessionId: wait.sessionId,
      userId: wait.userId,
      projectId: wait.projectId,
      workspaceId: wait.workspaceId,
      resourceRef: wait.resourceRef,
      managedThreadId: wait.managedThreadId,
    });
    expect(state.sessions.streamEvents.at(-1)).toMatchObject({ kind: 'system', message: prompt });
    expect(state.sessions.streamEvents.some((event) => event.kind === 'user' && event.message === prompt)).toBe(false);
    expect(state.audit.events.at(-1)).toMatchObject({ actorId: 'roadex-approval-coordinator', action: 'session.prompt' });

    controlled.settle({ ok: true, events: [], exitCode: 0, codexThreadId: wait.managedThreadId });
    await flushImmediate();
    expect(completed).toHaveBeenCalledWith(wait.continuationId, result.runnerRunId, {
      status: 'succeeded',
      managedThreadId: wait.managedThreadId,
    });
    expect(resolveActiveApprovalRunCapability(state, result.runnerRunId)).toBeUndefined();
    expect(lifecycle.revoked).toEqual([result.runnerRunId]);
  });

  it('denies noncanonical continuation text, exact binding failures, and duplicate dispatch', async () => {
    const controlled = runnerWithGate();
    const state = createInitialState(controlled.runner, createMemoryPersistence());
    const target = session();
    const wait = waitFor(target);
    projectWait(target, wait);
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    attachBridge(state);

    await expect(dispatchApprovalContinuation(state, wait, 'user supplied continuation'))
      .resolves.toEqual({ status: 'denied', reason: 'scope-mismatch' });
    const started = await dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait));
    expect(started.status).toBe('started');
    if (started.status === 'started') wait.runnerRunId = started.runnerRunId;
    await expect(dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait)))
      .resolves.toEqual({ status: 'denied', reason: 'scope-mismatch' });
    expect(controlled.requests).toHaveLength(1);

    controlled.settle({ ok: true, events: [], exitCode: 0, codexThreadId: wait.managedThreadId });
    await flushImmediate();
    await expect(dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait)))
      .resolves.toEqual({ status: 'denied', reason: 'scope-mismatch' });

    const mismatched = waitFor(target, { id: 'wait-other', managedThreadId: 'other-thread' });
    await expect(dispatchApprovalContinuation(state, mismatched, buildApprovalContinuation(mismatched)))
      .resolves.toEqual({ status: 'denied', reason: 'thread-mismatch' });
  });

  it('returns canonical capacity and ambiguous results without leaking thrown errors', async () => {
    const state = createInitialState({
      createSession: () => session(),
      runPrompt: () => { throw new Error('provider-secret-token'); },
    }, createMemoryPersistence());
    const first = session();
    const second = { ...session(), id: 'session-approval-2' };
    const firstWait = waitFor(first);
    const secondWait = waitFor(second, { id: 'wait-approval-2', sessionId: second.id });
    projectWait(first, firstWait);
    projectWait(second, secondWait);
    state.sessions.sessions.push(first, second);
    state.approvalWaits.push(firstWait, secondWait);
    attachBridge(state);
    state.maxActiveRuns = 0;

    const before = Date.now();
    const capacity = await dispatchApprovalContinuation(state, firstWait, buildApprovalContinuation(firstWait));
    expect(capacity.status).toBe('capacity');
    if (capacity.status === 'capacity') {
      expect(new Date(capacity.retryAt).toISOString()).toBe(capacity.retryAt);
      expect(Date.parse(capacity.retryAt)).toBeGreaterThan(before);
      expect(Date.parse(capacity.retryAt) - before).toBeLessThanOrEqual(60_000);
    }

    state.maxActiveRuns = 1;
    const ambiguous = await dispatchApprovalContinuation(state, secondWait, buildApprovalContinuation(secondWait));
    expect(ambiguous).toEqual({ status: 'ambiguous' });
    expect(JSON.stringify(state.audit.events)).not.toContain('provider-secret-token');
    expect(JSON.stringify(state.persistence.load())).not.toContain('provider-secret-token');
  });

  it('handles an immediately rejected approval runner without an unhandled rejection and reconciles it', async () => {
    const rejection = new Error('approval-runner-private-error');
    const state = createInitialState({
      createSession: () => session(),
      runPrompt: () => Promise.reject(rejection),
    }, createMemoryPersistence());
    const target = session();
    const wait = waitFor(target);
    projectWait(target, wait);
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    const completed = vi.fn(async () => ({ status: 'reconciliation-required' } as const));
    attachBridge(state, completed);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait));
      expect(result.status).toBe('started');
      await flushImmediate();
      await flushImmediate();
      expect(completed).toHaveBeenCalledWith(
        wait.continuationId,
        result.status === 'started' ? result.runnerRunId : '',
        { status: 'uncertain' },
      );
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(state.audit.events)).not.toContain(rejection.message);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not audit runner completion when coordinator completion did not resume the wait', async () => {
    const runner: SessionRunner = {
      createSession: () => session(),
      runPrompt: async () => ({ ok: true, events: [], exitCode: 0, codexThreadId: 'managed-thread-1' }),
    };
    const state = createInitialState(runner, createMemoryPersistence());
    const target = session();
    const wait = waitFor(target);
    projectWait(target, wait);
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    attachBridge(state, async () => ({ status: 'security-failure' }));

    expect((await dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait))).status).toBe('started');
    await flushImmediate();
    await flushImmediate();

    expect(state.audit.events.some((event) => event.action === 'session.runner_complete')).toBe(false);
    expect(target.lifecycle).toBe('paused');
  });

  it('fails closed when a successful approval runner omits its observed managed thread identity', async () => {
    const runner: SessionRunner = {
      createSession: () => session(),
      runPrompt: async () => ({ ok: true, events: [], exitCode: 0 }),
    };
    const state = createInitialState(runner, createMemoryPersistence());
    const target = session();
    const wait = waitFor(target);
    projectWait(target, wait);
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    const completed = vi.fn(async () => ({ status: 'reconciliation-required' } as const));
    attachBridge(state, completed);

    const result = await dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait));
    expect(result.status).toBe('started');
    await flushImmediate();

    expect(completed).toHaveBeenCalledWith(
      wait.continuationId,
      result.status === 'started' ? result.runnerRunId : '',
      { status: 'uncertain' },
    );
    expect(state.audit.events.some((event) => event.action === 'session.runner_complete')).toBe(false);
    expect(target.lifecycle).toBe('paused');
  });

  it('returns redacted ambiguity when approval run id generation fails', async () => {
    const state = createInitialState(runnerWithGate().runner, createMemoryPersistence());
    const target = session();
    const wait = waitFor(target);
    projectWait(target, wait);
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    attachBridge(state);
    state.generateApprovalRunId = () => {
      throw new Error('entropy-provider-private-error');
    };

    await expect(dispatchApprovalContinuation(state, wait, buildApprovalContinuation(wait)))
      .resolves.toEqual({ status: 'ambiguous' });
    expect(JSON.stringify(state.audit.events)).not.toContain('entropy-provider-private-error');
    expect(JSON.stringify(state.persistence.load())).not.toContain('entropy-provider-private-error');
  });

  it('persists waits through every session state save and reload', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(runnerWithGate().runner, persistence);
    const target = session();
    const wait = waitFor(target, { state: 'pending' });
    state.sessions.sessions.push(target);
    state.approvalWaits.push(wait);
    attachBridge(state);

    const denied = await dispatchApprovalContinuation(state, wait, 'not canonical');
    expect(denied.status).toBe('denied');

    const reloaded = createInitialState(runnerWithGate().runner, persistence);
    expect(reloaded.approvalWaits).toEqual([wait]);
  });

  it('completes exact successful continuations once and fails closed on mismatches or uncertainty', async () => {
    const target = session();
    const wait = waitFor(target, { runnerRunId: 'run-exact' });
    projectWait(target, wait);
    const waits = [wait];
    const audits: string[] = [];
    const published: string[] = [];
    const coordinator = new ApprovalCoordinator(waits, [target], { getStatus: vi.fn() }, {
      persist: vi.fn(),
      publish: (_sessionId, message) => published.push(message),
      audit: (action) => audits.push(action),
      queueContinuation: vi.fn(),
    }, { clock: { now: () => '2026-08-02T18:01:00.000Z' } });

    await coordinator.completeContinuation(wait.continuationId, 'run-exact', {
      status: 'succeeded',
      managedThreadId: wait.managedThreadId,
    });
    await coordinator.completeContinuation(wait.continuationId, 'run-exact', {
      status: 'succeeded',
      managedThreadId: wait.managedThreadId,
    });

    expect(wait).toMatchObject({ state: 'resumed', resumedAt: '2026-08-02T18:01:00.000Z' });
    expect(target).toMatchObject({ lifecycle: 'ready' });
    expect(target.waitingApproval).toBeUndefined();
    expect(audits.filter((action) => action === 'approval_wait.resume_completed')).toHaveLength(1);
    expect(published).toHaveLength(1);

    const mismatchTarget = session();
    mismatchTarget.id = 'session-mismatch';
    const mismatchWait = waitFor(mismatchTarget, {
      id: 'wait-mismatch',
      sessionId: mismatchTarget.id,
      runnerRunId: 'run-mismatch',
    });
    projectWait(mismatchTarget, mismatchWait);
    const uncertainTarget = session();
    uncertainTarget.id = 'session-uncertain';
    const uncertainWait = waitFor(uncertainTarget, {
      id: 'wait-uncertain',
      sessionId: uncertainTarget.id,
      runnerRunId: 'run-uncertain',
    });
    projectWait(uncertainTarget, uncertainWait);
    const secondCoordinator = new ApprovalCoordinator(
      [mismatchWait, uncertainWait],
      [mismatchTarget, uncertainTarget],
      { getStatus: vi.fn() },
      { persist: vi.fn(), publish: vi.fn(), audit: vi.fn(), queueContinuation: vi.fn() },
      { clock: { now: () => '2026-08-02T18:02:00.000Z' } },
    );

    await secondCoordinator.completeContinuation(mismatchWait.continuationId, 'run-mismatch', {
      status: 'succeeded',
      managedThreadId: 'wrong-thread',
    });
    await secondCoordinator.completeContinuation(uncertainWait.continuationId, 'run-uncertain', {
      status: 'uncertain',
    });
    expect(mismatchWait.state).toBe('security-failure');
    expect(uncertainWait.state).toBe('resume-reconciliation-required');
    await expect(secondCoordinator.completeContinuation('stale', 'run-stale', {
      status: 'uncertain',
    } as ApprovalContinuationCompletionOutcome)).resolves.toMatchObject({ status: 'stale' });
  });

  it('classifies a failed completion with a mismatched observed thread as a security failure', async () => {
    const target = session();
    const wait = waitFor(target, { runnerRunId: 'run-failed-thread-mismatch' });
    projectWait(target, wait);
    const coordinator = new ApprovalCoordinator(
      [wait],
      [target],
      { getStatus: vi.fn() },
      { persist: vi.fn(), publish: vi.fn(), audit: vi.fn(), queueContinuation: vi.fn() },
      { clock: { now: () => '2026-08-02T18:03:00.000Z' } },
    );

    await expect(coordinator.completeContinuation(
      wait.continuationId,
      'run-failed-thread-mismatch',
      { status: 'failed', managedThreadId: 'wrong-managed-thread' },
    )).resolves.toEqual({ status: 'security-failure' });
    expect(wait.state).toBe('security-failure');
    expect(target.lifecycle).toBe('paused');
  });

  it('recovers persisted waits without redispatching an unacknowledged continuation', async () => {
    const pendingSession = session();
    pendingSession.id = 'session-recovery-pending';
    const pendingWait = waitFor(pendingSession, {
      id: 'wait-recovery-pending',
      sessionId: pendingSession.id,
      state: 'pending',
      runnerRunId: undefined,
      dispatchReservedAt: undefined,
    });
    projectWait(pendingSession, pendingWait);

    const queuedSession = session();
    queuedSession.id = 'session-recovery-queued';
    const queuedWait = waitFor(queuedSession, {
      id: 'wait-recovery-queued',
      sessionId: queuedSession.id,
      state: 'approved-resume-queued',
      runnerRunId: undefined,
      dispatchReservedAt: undefined,
    });
    projectWait(queuedSession, queuedWait);

    const dispatchingSession = session();
    dispatchingSession.id = 'session-recovery-dispatching';
    const dispatchingWait = waitFor(dispatchingSession, {
      id: 'wait-recovery-dispatching',
      sessionId: dispatchingSession.id,
      state: 'resume-dispatching',
      runnerRunId: undefined,
    });
    projectWait(dispatchingSession, dispatchingWait);

    const queuedRetryAt = '2026-08-02T18:00:02.000Z';
    const queueContinuation = vi.fn(async () => ({ status: 'capacity', retryAt: queuedRetryAt } as const));
    const coordinator = new ApprovalCoordinator(
      [pendingWait, queuedWait, dispatchingWait],
      [pendingSession, queuedSession, dispatchingSession],
      { getStatus: vi.fn(async () => { throw new Error('provider unavailable during recovery'); }) },
      { persist: vi.fn(), publish: vi.fn(), audit: vi.fn(), queueContinuation },
      { clock: { now: () => NOW }, backoffJitter: () => 0 },
    );

    await coordinator.recover();

    expect(pendingWait.state).toBe('pending');
    expect(queuedWait).toMatchObject({ state: 'approved-resume-queued', nextCheckAt: queuedRetryAt });
    expect(dispatchingWait.state).toBe('resume-reconciliation-required');
    expect(queueContinuation).toHaveBeenCalledTimes(1);
    expect(queueContinuation).toHaveBeenCalledWith(queuedWait, buildApprovalContinuation(queuedWait));
  });
});
