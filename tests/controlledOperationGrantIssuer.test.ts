import { describe, expect, it, vi } from 'vitest';
import { createControlledOperationGrantIssuer } from '../src/server/controlledOperationGrantIssuer';
import {
  decodeSignedControlledOperationGrant,
  authenticateControlledOperationGrant,
  type ControlledWorkspaceSnapshot,
} from '../src/server/controlledOperations';
import type { RoadexSession, UserProfile } from '../src/shared/sessionContracts';

const key = 'k'.repeat(32);
const env = {
  ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
  ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'owner',
  ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: 'donuthole',
  ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: key,
  ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY: 'a'.repeat(32),
  ROADEX_CONTROLLED_OPERATIONS_REPOSITORIES_JSON:
    '{"donuthole":{"repository":"owner/DonutHole","visibility":"private"}}',
};
const user: UserProfile = {
  id: 'owner',
  displayName: 'Owner',
  authMode: 'protected-gateway',
  roles: ['user', 'admin', 'security-reviewer'],
};
const session: RoadexSession = {
  id: 'session',
  userId: 'owner',
  workspace: { id: 'donuthole', name: 'DonutHole', root: '/srv/donuthole' },
  lifecycle: 'ready',
  runnerMode: 'codex',
  transport: 'sse',
  deviceBridge: 'disabled',
  gates: [],
  managedThreadId: 'thread',
  codexThreadId: 'thread',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};
const snapshot: ControlledWorkspaceSnapshot = {
  workspaceId: 'donuthole',
  workspaceRoot: '/srv/donuthole',
  managedThreadId: 'thread',
  repository: 'owner/DonutHole',
  remote: 'git@github.com:owner/DonutHole.git',
  branch: 'main',
  headCommit: '1'.repeat(40),
  upstreamRef: 'refs/remotes/origin/main',
  upstreamCommit: '2'.repeat(40),
  workingTreeState: 'dirty',
  aheadCount: 0,
  behindCount: 0,
  treeDigest: 'a'.repeat(64),
  manifestDigest: 'b'.repeat(64),
  lockfileState: 'validated',
  visibility: 'private',
};

describe('controlled operation grant issuer', () => {
  it('requires protected reviewed ownership, exact allowlists, managed thread identity, and configured repository', () => {
    const inspect = vi.fn(() => snapshot);
    const issue = createControlledOperationGrantIssuer(env, inspect);
    const token = issue({ user, session, prompt: 'commit and push' });
    expect(token).toBeDefined();
    const grant = authenticateControlledOperationGrant({
      token: decodeSignedControlledOperationGrant(token ?? ''),
      hmacKey: key,
    });
    expect(grant).toMatchObject({
      userId: 'owner',
      sessionId: 'session',
      repository: 'owner/DonutHole',
      intent: 'commit-and-push',
    });
    expect(inspect).toHaveBeenCalledTimes(1);

    expect(issue({
      user: { ...user, roles: ['user'] },
      session,
      prompt: 'commit and push',
    })).toBeUndefined();
    expect(issue({
      user: { ...user, id: 'other', roles: ['user', 'security-reviewer'] },
      session: { ...session, userId: 'other' },
      prompt: 'commit and push',
    })).toBeUndefined();
    expect(issue({
      user,
      session: { ...session, codexThreadId: 'different' },
      prompt: 'commit and push',
    })).toBeUndefined();
  });

  it('fails closed for malformed configuration and repository drift', () => {
    expect(createControlledOperationGrantIssuer(
      { ...env, ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'TRUE' },
      () => snapshot,
    )({ user, session, prompt: 'commit' })).toBeUndefined();
    expect(createControlledOperationGrantIssuer(
      env,
      () => ({ ...snapshot, repository: 'owner/Other' }),
    )({ user, session, prompt: 'commit' })).toBeUndefined();
  });
});
