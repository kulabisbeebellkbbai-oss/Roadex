import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildControlledOperationPlan,
  ControlledOperationError,
  type ControlledOperationGrant,
} from '../src/server/controlledOperations';
import {
  createGithubSshNetworkAdapter,
  createNpmRegistryNetworkAdapter,
} from '../src/server/controlledOperationsNetworkAdapters';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('controlled operation network adapters', () => {
  it('rejects an altered npm command before execution', async () => {
    const root = workspace();
    const command = buildControlledOperationPlan(grant(root, 'install-and-verify')).commands[0];
    command.args.push('--proxy', 'https://example.test');
    await expect(createNpmRegistryNetworkAdapter(async () => ['127.0.0.1']).execute(
      command,
      root,
      root,
      -1,
    )).rejects.toEqual(new ControlledOperationError('network_policy_invalid'));
  });

  it('rejects invalid resolved addresses before execution', async () => {
    const root = workspace();
    const command = buildControlledOperationPlan(grant(root, 'install-and-verify')).commands[0];
    await expect(createNpmRegistryNetworkAdapter(async () => ['not-an-address']).execute(
      command,
      root,
      root,
      -1,
    )).rejects.toEqual(new ControlledOperationError('network_resolution_failed'));
  });

  it.each([
    '127.0.0.1',
    '10.50.0.100',
    '169.254.1.1',
    '192.168.1.1',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '2001:2::1',
    '2001:db8::1',
    '2002::1',
    '2620:4f:8000::1',
    '3fff::1',
  ])('rejects non-global resolved address %s', async (address) => {
    const root = workspace();
    const command = buildControlledOperationPlan(grant(root, 'install-and-verify')).commands[0];
    await expect(createNpmRegistryNetworkAdapter(async () => [address]).execute(
      command,
      root,
      root,
    )).rejects.toEqual(new ControlledOperationError('network_resolution_failed'));
  });

  it('rejects an unbounded resolved address set before execution', async () => {
    const root = workspace();
    const command = buildControlledOperationPlan(grant(root, 'install-and-verify')).commands[0];
    await expect(createNpmRegistryNetworkAdapter(async () =>
      Array.from({ length: 33 }, (_, index) => `8.8.${Math.floor(index / 254)}.${(index % 254) + 1}`),
    ).execute(command, root, root, -1)).rejects.toEqual(
      new ControlledOperationError('network_resolution_failed'),
    );
  });

  it('rejects an altered GitHub push command before credential inspection', async () => {
    const root = workspace();
    const command = buildControlledOperationPlan(grant(root, 'commit-and-push'), 'Update project')
      .commands.at(-1)!;
    command.args[command.args.indexOf('origin')] = 'https://example.test/repository';
    await expect(createGithubSshNetworkAdapter(async () => ['127.0.0.1']).execute(
      command,
      root,
      root,
      -1,
    )).rejects.toEqual(new ControlledOperationError('network_policy_invalid'));
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'roadex-network-adapter-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package.json'), '{}\n');
  return root;
}

function grant(
  workspaceRoot: string,
  intent: ControlledOperationGrant['intent'],
): ControlledOperationGrant {
  return {
    version: 1,
    profile: 'roadex-controlled-operations-v1',
    operationId: 'controlled-operation-11111111-1111-4111-8111-111111111111',
    nonce: '22222222-2222-4222-8222-222222222222',
    userId: 'owner',
    sessionId: 'session',
    intent,
    issuedAt: '2026-07-30T00:00:00.000Z',
    expiresAt: '2026-07-30T00:10:00.000Z',
    workspaceId: 'workspace',
    workspaceRoot,
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
}
