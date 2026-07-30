import { describe, expect, it } from 'vitest';
import {
  ControlledOperationError,
  ControlledOperationReplayStore,
  controlledOperationPolicyFromEnv,
  encodeSignedControlledOperationGrant,
  issueControlledOperationGrant,
  type ControlledWorkspaceSnapshot,
} from '../src/server/controlledOperations';
import { ControlledOperationsBroker } from '../src/server/controlledOperationsBroker';

const key = 'b'.repeat(32);
const snapshot: ControlledWorkspaceSnapshot = {
  workspaceId: 'workspace',
  workspaceRoot: '/srv/workspace',
  managedThreadId: 'thread',
  repository: 'owner/repository',
  remote: 'git@github.com:owner/repository.git',
  branch: 'main',
  headCommit: '1'.repeat(40),
  upstreamRef: 'refs/remotes/origin/main',
  upstreamCommit: '2'.repeat(40),
  treeDigest: 'a'.repeat(64),
  manifestDigest: 'c'.repeat(64),
  lockfileState: 'validated',
  visibility: 'private',
};

describe('controlled operations broker', () => {
  it('revalidates state, matches intent to tool, and executes one fixed plan', async () => {
    const plans: unknown[] = [];
    const broker = createBroker(snapshot, plans);
    const result = await broker.execute({
      token: token('commit and push'),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    });
    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      intent: 'commit-and-push',
      workspaceRoot: snapshot.workspaceRoot,
    });
  });

  it('denies intent mismatch, state drift, replay, and unknown tools', async () => {
    const plans: unknown[] = [];
    const broker = createBroker(snapshot, plans);
    expect(await broker.execute({
      token: token('commit and push'),
      tool: 'install_and_verify_workspace',
    })).toMatchObject({ ok: false, reason: 'intent_mismatch' });

    const drifted = createBroker({ ...snapshot, treeDigest: 'd'.repeat(64) }, plans);
    expect(await drifted.execute({
      token: token('commit and push'),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).toMatchObject({ ok: false, reason: 'workspace_drift' });

    const replayToken = token('commit and push');
    const replayBroker = createBroker(snapshot, plans);
    expect((await replayBroker.execute({
      token: replayToken,
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).ok).toBe(true);
    expect(await replayBroker.execute({
      token: replayToken,
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).toMatchObject({ ok: false, reason: 'grant_replayed' });

    expect(await broker.execute({
      token: token('commit and push'),
      tool: 'execute_shell' as never,
    })).toMatchObject({ ok: false, reason: 'tool_denied' });
  });

  it('projects failures without returning executor secrets', async () => {
    const broker = new ControlledOperationsBroker({
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      resolveCurrentSnapshot: async () => snapshot,
      auditPublication: async () => {},
      executePlan: async () => ({
        ok: false,
        summary: 'Bearer secret.value ghp_abcdefghijklmnopqrstuvwxyz123456',
      }),
    });
    const result = await broker.execute({
      token: token('commit'),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    });
    expect(result).toMatchObject({ ok: false, status: 'failed', reason: 'operation_failed' });
    expect(JSON.stringify(result)).not.toContain('secret.value');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('does not resolve a workspace path from an unauthenticated grant', async () => {
    const resolved: string[] = [];
    const broker = new ControlledOperationsBroker({
      hmacKey: key,
      resolveCurrentSnapshot: async (grant) => {
        resolved.push(grant.workspaceRoot);
        return snapshot;
      },
      auditPublication: async () => {},
      executePlan: async () => ({ ok: true, summary: 'Completed.' }),
    });
    const signed = issueControlledOperationGrant({
      policy: controlledOperationPolicyFromEnv({
        ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
        ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'owner',
        ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: snapshot.workspaceId,
        ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: key,
      }),
      userId: 'owner',
      sessionId: 'session',
      prompt: 'commit',
      snapshot,
    });
    if (!signed) throw new Error('grant not issued');
    const payload = JSON.parse(Buffer.from(signed.payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.workspaceRoot = '/etc';
    signed.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const result = await broker.execute({
      token: encodeSignedControlledOperationGrant(signed),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    });
    expect(result).toMatchObject({ ok: false, reason: 'grant_invalid' });
    expect(resolved).toEqual([]);
  });

  it('enforces publication audit before consuming or executing a grant', async () => {
    const replayStore = new ControlledOperationReplayStore();
    let executed = false;
    const broker = new ControlledOperationsBroker({
      hmacKey: key,
      replayStore,
      resolveCurrentSnapshot: async () => snapshot,
      auditPublication: async () => {
        throw new ControlledOperationError('sensitive_content_denied');
      },
      executePlan: async () => {
        executed = true;
        return { ok: true, summary: 'Completed.' };
      },
    });
    const grant = token('commit and push');
    expect(await broker.execute({
      token: grant,
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).toMatchObject({ ok: false, reason: 'sensitive_content_denied' });
    expect(executed).toBe(false);

    const retry = new ControlledOperationsBroker({
      hmacKey: key,
      replayStore,
      resolveCurrentSnapshot: async () => snapshot,
      auditPublication: async () => {},
      executePlan: async () => ({ ok: true, summary: 'Completed.' }),
    });
    expect((await retry.execute({
      token: grant,
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).ok).toBe(true);
  });

  it('revalidates repository state after publication audit before consumption', async () => {
    let inspections = 0;
    const broker = new ControlledOperationsBroker({
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      resolveCurrentSnapshot: async () => {
        inspections += 1;
        return inspections === 1 ? snapshot : { ...snapshot, headCommit: 'f'.repeat(40) };
      },
      auditPublication: async () => {},
      executePlan: async () => ({ ok: true, summary: 'Completed.' }),
    });
    expect(await broker.execute({
      token: token('commit and push'),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).toMatchObject({ ok: false, reason: 'workspace_drift' });
  });

  it('durably audits acceptance and terminal failure when execution throws', async () => {
    const phases: string[] = [];
    const broker = new ControlledOperationsBroker({
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      resolveCurrentSnapshot: async () => snapshot,
      auditPublication: async () => {},
      auditAccepted: async () => { phases.push('accepted'); },
      auditResult: async (_grant, result) => { phases.push(result.status ?? 'unknown'); },
      executePlan: async () => { throw new Error('injected failure'); },
    });
    expect(await broker.execute({
      token: token('commit'),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).toMatchObject({ ok: false, status: 'failed', reason: 'operation_failed' });
    expect(phases).toEqual(['accepted', 'failed']);
  });

  it('reports an indeterminate audit state without claiming a completed mutation was denied', async () => {
    const broker = new ControlledOperationsBroker({
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      resolveCurrentSnapshot: async () => snapshot,
      auditPublication: async () => {},
      auditAccepted: async () => {},
      auditResult: async () => { throw new Error('injected audit failure'); },
      executePlan: async () => ({ ok: true, summary: 'Completed.' }),
    });
    expect(await broker.execute({
      token: token('commit'),
      tool: 'publish_git_changes',
      commitMessage: 'Update fixture',
    })).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'audit_indeterminate',
      operationId: expect.any(String),
    });
  });
});

function createBroker(current: ControlledWorkspaceSnapshot, plans: unknown[]) {
  return new ControlledOperationsBroker({
    hmacKey: key,
    replayStore: new ControlledOperationReplayStore(),
    resolveCurrentSnapshot: async () => current,
    auditPublication: async () => {},
    executePlan: async (plan) => {
      plans.push(plan);
      return { ok: true, summary: 'Completed.' };
    },
  });
}

function token(prompt: string): string {
  const signed = issueControlledOperationGrant({
    policy: controlledOperationPolicyFromEnv({
      ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
      ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'owner',
      ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: snapshot.workspaceId,
      ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: key,
    }),
    userId: 'owner',
    sessionId: 'session',
    prompt,
    snapshot,
  });
  if (!signed) throw new Error('grant not issued');
  return encodeSignedControlledOperationGrant(signed);
}
