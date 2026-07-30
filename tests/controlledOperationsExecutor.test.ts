import { describe, expect, it, vi } from 'vitest';
import { closeSync, constants as fsConstants, mkdtempSync, openSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildControlledOperationPlan,
  ControlledOperationError,
  type ControlledOperationGrant,
  type ControlledWorkspaceSnapshot,
} from '../src/server/controlledOperations';
import {
  ControlledOperationsExecutor,
  createBubblewrapNoNetworkAdapter,
  type ControlledCommandAdapter,
} from '../src/server/controlledOperationsExecutor';

const snapshot: ControlledWorkspaceSnapshot = {
  workspaceId: 'workspace',
  workspaceRoot: mkdtempSync(join(tmpdir(), 'roadex-executor-')),
  managedThreadId: 'thread',
  repository: 'owner/repository',
  remote: 'git@github.com:owner/repository.git',
  branch: 'main',
  headCommit: '1'.repeat(40),
  upstreamRef: 'refs/remotes/origin/main',
  upstreamCommit: '2'.repeat(40),
  treeDigest: 'a'.repeat(64),
  manifestDigest: 'b'.repeat(64),
  lockfileState: 'validated',
  visibility: 'private',
};

const grant: ControlledOperationGrant = {
  ...snapshot,
  version: 1,
  profile: 'roadex-controlled-operations-v1',
  operationId: 'controlled-operation-11111111-1111-4111-8111-111111111111',
  nonce: '22222222-2222-4222-8222-222222222222',
  userId: 'owner',
  sessionId: 'session',
  intent: 'commit-and-push',
  issuedAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-07-30T00:10:00.000Z',
};

describe('controlled operations executor', () => {
  it('rejects an altered plan before selecting an adapter', async () => {
    const adapter = successfulAdapter();
    const executor = createExecutor({ noNetwork: adapter, githubSsh: adapter });
    const plan = buildControlledOperationPlan(grant, 'Update project');
    plan.commands[0].args.push('--global');
    await expect(executor.execute(plan, grant)).rejects.toEqual(new ControlledOperationError('plan_invalid'));
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('routes denied and GitHub commands through distinct adapters and audits before push', async () => {
    const noNetwork = successfulAdapter();
    const githubSsh = successfulAdapter();
    const auditPublication = vi.fn(async () => {});
    const executor = createExecutor({ noNetwork, githubSsh, auditPublication });
    await expect(executor.execute(
      buildControlledOperationPlan(grant, 'Update project'),
      grant,
    )).resolves.toMatchObject({ ok: true });
    expect(noNetwork.execute).toHaveBeenCalledTimes(4);
    expect(githubSsh.execute).toHaveBeenCalledTimes(1);
    expect(auditPublication).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a required network adapter is absent', async () => {
    const executor = createExecutor({ noNetwork: successfulAdapter() });
    await expect(executor.execute(
      buildControlledOperationPlan(grant, 'Update project'),
      grant,
    )).rejects.toEqual(new ControlledOperationError('network_adapter_unavailable'));
  });

  it('requires a validated generated lock before npm ci', async () => {
    const missingGrant = { ...grant, intent: 'install-and-verify' as const, lockfileState: 'missing' as const };
    const inspected = vi.fn(async (_grant: ControlledOperationGrant, allowMissing: boolean) => ({
      ...snapshot,
      lockfileState: allowMissing ? 'missing' as const : 'validated' as const,
      treeDigest: 'c'.repeat(64),
      manifestDigest: 'd'.repeat(64),
    }));
    const executor = new ControlledOperationsExecutor({
      noNetwork: successfulAdapter(),
      npmRegistry: successfulAdapter(),
      inspectWorkspace: inspected,
      auditPublication: async () => {},
    });
    await expect(executor.execute(
      buildControlledOperationPlan(missingGrant),
      missingGrant,
    )).resolves.toMatchObject({ ok: true });
    expect(inspected).toHaveBeenCalledWith(missingGrant, false, expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/));
  });

  it('enforces real filesystem, namespace, and process resource isolation', async () => {
    const hostNetNamespace = readlinkSync('/proc/self/ns/net');
    const hostPidNamespace = readlinkSync('/proc/self/ns/pid');
    const descriptor = openSync(
      process.cwd(),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      const result = await createBubblewrapNoNetworkAdapter().execute({
        executable: '/usr/bin/sh',
        args: [
          '-c',
          [
            'test ! -e /home/god/.ssh',
            'test ! -e /run/user',
            'test ! -e /etc/passwd',
            'readlink /proc/self/ns/net',
            'readlink /proc/self/ns/pid',
            'cat /proc/self/limits',
          ].join(' && '),
        ],
        network: 'denied',
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
      }, `/proc/${process.pid}/fd/${descriptor}`, process.cwd(), descriptor);
      expect(result.exitCode).toBe(0);
      const lines = result.output.trim().split(/\r?\n/);
      expect(lines[0]).not.toBe(hostNetNamespace);
      expect(lines[1]).not.toBe(hostPidNamespace);
      expect(result.output).toMatch(/Max file size\s+1073741824\s+1073741824/);
      expect(result.output).toMatch(/Max address space\s+unlimited\s+unlimited/);
    } finally {
      closeSync(descriptor);
    }
  }, 40_000);
});

function successfulAdapter(): ControlledCommandAdapter {
  return { execute: vi.fn(async () => ({ exitCode: 0, output: 'ok' })) };
}

function createExecutor(overrides: Partial<ConstructorParameters<typeof ControlledOperationsExecutor>[0]> = {}) {
  return new ControlledOperationsExecutor({
    noNetwork: successfulAdapter(),
    inspectWorkspace: async () => snapshot,
    auditPublication: async () => {},
    ...overrides,
  });
}
