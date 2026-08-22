import { describe, expect, it, vi } from 'vitest';
import { adapterEnvironment, ProjectCreationWorker } from '../src/server/projectCreationWorker';
import type { ProjectCreationExecutionLease } from '../src/server/projectCreationBroker';
import type { UserProfile } from '../src/shared/sessionContracts';

const owner: UserProfile = {
  id: 'owner',
  displayName: 'Owner',
  authMode: 'protected-gateway',
  roles: ['user', 'admin', 'security-reviewer'],
};

const lease: ProjectCreationExecutionLease = {
  operationId: 'project-operation-abcdefgh',
  proposalId: 'project-proposal-abcdefgh',
  leaseToken: 'private-lease-token',
  startPhase: 'reserved',
  spec: {
    operationId: 'project-operation-abcdefgh',
    projectName: 'Project Alpha',
    visibility: 'private',
    githubOwner: 'owner-name',
    workspaceRoot: '/home/god/Documents/Codex Workspace',
    summaryMarkdown: '# Summary',
    aTeamPlanMarkdown: '# Team',
  },
};

const readyFinalizer = {
  ready: () => true,
  finalize: vi.fn(async () => ({
    workspaceId: 'workspace-project-alpha',
    workspaceRoot: '/home/god/Documents/Codex Workspace/Project Alpha',
    managedThreadId: 'thread-project-alpha',
  })),
};

describe('ProjectCreationWorker', () => {
  it('forwards keyring runtime locators without broadening the child environment', () => {
    expect(adapterEnvironment({
      HOME: '/home/test',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      GH_TOKEN: 'test-token',
      npm_config_user_agent: 'excluded',
    })).toEqual({
      HOME: '/home/test',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      GH_TOKEN: 'test-token',
    });
  });

  it('refuses before claiming a lease when controlled bootstrap or registration is disabled', async () => {
    const claimExecution = vi.fn(async () => lease);
    const execute = vi.fn();
    const worker = new ProjectCreationWorker({
      claimExecution,
      advanceExecution: vi.fn(async () => false),
    }, execute, {
      ready: () => false,
      finalize: vi.fn(async () => ({
        workspaceId: 'workspace-project-alpha',
        workspaceRoot: '/home/god/Documents/Codex Workspace/Project Alpha',
        managedThreadId: 'thread-project-alpha',
      })),
    });
    expect(await worker.run(owner, lease.proposalId)).toBe(false);
    expect(claimExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does nothing when the broker execution gate refuses a lease', async () => {
    const execute = vi.fn();
    const worker = new ProjectCreationWorker({
      claimExecution: vi.fn(async () => undefined),
      advanceExecution: vi.fn(async () => false),
    }, execute, readyFinalizer);
    expect(await worker.run(owner, lease.proposalId)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists every adapter phase without exposing command output', async () => {
    const advanceExecution = vi.fn(async () => true);
    const worker = new ProjectCreationWorker({
      claimExecution: vi.fn(async () => lease),
      advanceExecution,
    }, async (_lease, onEvent) => {
      for (const phase of ['local-prepared', 'remote-created', 'pushed'] as const) {
        await onEvent({ type: 'phase', phase });
      }
      await onEvent({ type: 'done' });
    }, readyFinalizer);
    expect(await worker.run(owner, lease.proposalId)).toBe(true);
    expect(advanceExecution.mock.calls.map((call) => call[3])).toEqual([
      'local-prepared', 'remote-created', 'pushed', 'thread-started', 'completed',
    ]);
    expect(advanceExecution.mock.calls[3]?.[5]).toEqual({
      workspaceId: 'workspace-project-alpha',
      workspaceRoot: '/home/god/Documents/Codex Workspace/Project Alpha',
      managedThreadId: 'thread-project-alpha',
    });
    expect(JSON.stringify(advanceExecution.mock.calls)).not.toContain('command output');
  });

  it('records the dedicated human thread before completing project creation', async () => {
    const advanceExecution = vi.fn(async () => true);
    const provision = vi.fn(async () => undefined);
    const worker = new ProjectCreationWorker({
      claimExecution: vi.fn(async () => lease), advanceExecution,
    }, async (_lease, onEvent) => {
      for (const phase of ['local-prepared', 'remote-created', 'pushed'] as const) await onEvent({ type: 'phase', phase });
      await onEvent({ type: 'done' });
    }, readyFinalizer, { provision });
    expect(await worker.run(owner, lease.proposalId)).toBe(true);
    expect(provision).toHaveBeenCalledWith(owner, lease, expect.objectContaining({ workspaceId: 'workspace-project-alpha' }));
    expect(provision.mock.invocationCallOrder[0]).toBeLessThan(
      advanceExecution.mock.invocationCallOrder[advanceExecution.mock.invocationCallOrder.length - 1],
    );
  });

  it('resumes an exact thread-started checkpoint without running the external adapter again', async () => {
    const finalization = {
      workspaceId: 'workspace-project-alpha',
      workspaceRoot: '/home/god/Documents/Codex Workspace/Project Alpha',
      managedThreadId: '019fc36f-0570-7623-912f-6da8181eda2d',
    };
    const resumed = { ...lease, startPhase: 'thread-started' as const, finalization };
    const advanceExecution = vi.fn(async () => true);
    const provision = vi.fn(async () => undefined);
    const execute = vi.fn();
    const worker = new ProjectCreationWorker({ claimExecution: vi.fn(async () => resumed), advanceExecution },
      execute, readyFinalizer, { provision });
    expect(await worker.run(owner, lease.proposalId)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(provision).toHaveBeenCalledWith(owner, resumed, finalization);
    expect(advanceExecution).toHaveBeenCalledWith(owner, lease.operationId, lease.leaseToken, 'completed');
  });

  it('classifies ambiguous external failure as reconciliation-required', async () => {
    const advanceExecution = vi.fn(async () => true);
    const worker = new ProjectCreationWorker({
      claimExecution: vi.fn(async () => lease),
      advanceExecution,
    }, async (_lease, onEvent) => {
      await onEvent({ type: 'failed', classification: 'remote_verification_failed', reconcileRequired: true });
    }, readyFinalizer);
    expect(await worker.run(owner, lease.proposalId)).toBe(true);
    expect(advanceExecution).toHaveBeenCalledWith(
      owner, lease.operationId, lease.leaseToken, 'reconcile-required', 'remote_verification_failed',
    );
  });

  it('marks controlled bootstrap or registrar ambiguity for reconciliation', async () => {
    const advanceExecution = vi.fn(async () => true);
    const worker = new ProjectCreationWorker({
      claimExecution: vi.fn(async () => lease),
      advanceExecution,
    }, async (_lease, onEvent) => {
      await onEvent({ type: 'phase', phase: 'local-prepared' });
      await onEvent({ type: 'phase', phase: 'remote-created' });
      await onEvent({ type: 'phase', phase: 'pushed' });
      await onEvent({ type: 'done' });
    }, {
      ready: () => true,
      finalize: vi.fn(async () => {
        throw new Error('ambiguous');
      }),
    });
    expect(await worker.run(owner, lease.proposalId)).toBe(false);
    expect(advanceExecution).toHaveBeenLastCalledWith(
      owner, lease.operationId, lease.leaseToken, 'reconcile-required', 'worker_protocol_failed',
    );
  });

  it('treats a rejected remote checkpoint as reconciliation-required', async () => {
    const advanceExecution = vi.fn(async (
      _user: UserProfile,
      _operationId: string,
      _leaseToken: string,
      phase: string,
    ) => phase === 'reconcile-required');
    const worker = new ProjectCreationWorker({
      claimExecution: vi.fn(async () => lease),
      advanceExecution,
    }, async (_lease, onEvent) => {
      await onEvent({ type: 'phase', phase: 'remote-created' });
    }, readyFinalizer);
    expect(await worker.run(owner, lease.proposalId)).toBe(false);
    expect(advanceExecution).toHaveBeenLastCalledWith(
      owner, lease.operationId, lease.leaseToken, 'reconcile-required', 'worker_protocol_failed',
    );
  });
});
