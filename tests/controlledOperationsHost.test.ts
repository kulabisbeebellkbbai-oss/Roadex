import { readFileSync, mkdtempSync, writeSync as importWriteSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlledOperationsAuditWriter } from '../src/server/controlledOperationsAudit';
import { hostConfigFromEnv } from '../src/server/controlledOperationsHost';
import type { ControlledOperationGrant } from '../src/server/controlledOperations';

const enabledEnv = {
  ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
  ROADEX_CONTROLLED_OPERATIONS_EXECUTOR_ENABLED: 'true',
  ROADEX_CONTROLLED_OPERATIONS_LISTENER_ENABLED: 'true',
  ROADEX_CONTROLLED_OPERATIONS_NPM_ADAPTER_ENABLED: 'true',
  ROADEX_CONTROLLED_OPERATIONS_GITHUB_SSH_ADAPTER_ENABLED: 'true',
  ROADEX_CONTROLLED_OPERATION_SOCKET: '/run/user/1000/roadex-controlled-operations.sock',
  ROADEX_CONTROLLED_OPERATIONS_REPLAY_PATH: '/home/god/.local/share/roadex-controlled-operations/replay',
  ROADEX_CONTROLLED_OPERATIONS_AUDIT_PATH: '/home/god/.local/share/roadex-controlled-operations/audit/events.jsonl',
  ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: 'h'.repeat(32),
  ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY: 'a'.repeat(32),
};

describe('controlled operations host configuration', () => {
  it('requires every literal gate, fixed socket, private paths, and separated keys', () => {
    expect(hostConfigFromEnv(enabledEnv)).toMatchObject({
      socketPath: '/run/user/1000/roadex-controlled-operations.sock',
    });
    expect(() => hostConfigFromEnv({
      ...enabledEnv,
      ROADEX_CONTROLLED_OPERATIONS_LISTENER_ENABLED: 'TRUE',
    })).toThrow('host_disabled');
    expect(() => hostConfigFromEnv({
      ...enabledEnv,
      ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY: enabledEnv.ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY,
    })).toThrow('host_configuration_invalid');
  });

  it('writes only pseudonymized durable audit fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-audit-'));
    const path = join(root, 'events.jsonl');
    const writer = new ControlledOperationsAuditWriter(path, 'a'.repeat(32));
    writer.append(grant(), {
      ok: true,
      operationId: 'controlled-operation-secret',
      status: 'completed',
      summary: 'private output',
    });
    const output = readFileSync(path, 'utf8');
    expect(output).toContain('"action":"controlled_operation.result"');
    expect(output).not.toContain('/srv/private');
    expect(output).not.toContain('owner/repository');
    expect(output).not.toContain('private output');
    expect(output).not.toContain('controlled-operation-secret');
    expect(output).not.toContain('"owner"');
  });

  it('completes partial writes and fails closed when a writer makes no progress', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-audit-short-'));
    const path = join(root, 'events.jsonl');
    const partialWriter: typeof import('node:fs').writeSync = (fd, buffer, offset, length) =>
      importWriteSync(fd, buffer, offset, Math.min(length, 7));
    new ControlledOperationsAuditWriter(path, 'a'.repeat(32), partialWriter).append(
      grant(),
      { ok: true, status: 'completed' },
    );
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();

    const blockedPath = join(root, 'blocked.jsonl');
    const noProgress: typeof import('node:fs').writeSync = () => 0;
    expect(() => new ControlledOperationsAuditWriter(
      blockedPath,
      'a'.repeat(32),
      noProgress,
    ).append(grant(), { ok: true, status: 'completed' })).toThrow('audit_write_failed');
  });
});

function grant(): ControlledOperationGrant {
  return {
    version: 1,
    profile: 'roadex-controlled-operations-v1',
    operationId: 'controlled-operation-11111111-1111-4111-8111-111111111111',
    nonce: '22222222-2222-4222-8222-222222222222',
    userId: 'owner',
    sessionId: 'session',
    intent: 'commit',
    issuedAt: '2026-07-30T00:00:00.000Z',
    expiresAt: '2026-07-30T00:10:00.000Z',
    workspaceId: 'workspace',
    workspaceRoot: '/srv/private',
    managedThreadId: 'thread',
    repository: 'owner/repository',
    remote: 'git@github.com:owner/repository.git',
    branch: 'main',
  headCommit: '1'.repeat(40),
  workingTreeState: 'dirty',
  aheadCount: 0,
  behindCount: 0,
    treeDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    lockfileState: 'validated',
    visibility: 'private',
  };
}
