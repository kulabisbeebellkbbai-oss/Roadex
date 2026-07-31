import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_GITHUB_KNOWN_HOSTS,
  CONTROLLED_GITHUB_SSH_KEY,
  ControlledOperationError,
  ControlledOperationReplayStore,
  buildControlledOperationPlan,
  classifyControlledOperationIntent,
  controlledOperationPolicyFromEnv,
  issueControlledOperationGrant,
  sanitizeControlledOperationResult,
  sanitizeControlledOperationTail,
  validatePackageManifests,
  verifyAndConsumeControlledOperationGrant,
  type ControlledWorkspaceSnapshot,
} from '../src/server/controlledOperations';

const key = 'k'.repeat(32);
const snapshot: ControlledWorkspaceSnapshot = {
  workspaceId: 'codex-project-donuthole-5ccf3f70',
  workspaceRoot: '/home/god/Documents/Codex Workspace/DonutHole',
  managedThreadId: 'thread-donuthole',
  repository: 'kulabisbeebellkbbai-oss/DonutHole',
  remote: 'git@github.com:kulabisbeebellkbbai-oss/DonutHole.git',
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

describe('controlled operation authorization', () => {
  it('recognizes only exact direct operation instructions', () => {
    expect(classifyControlledOperationIntent('commit and push')).toBe('commit-and-push');
    expect(classifyControlledOperationIntent('commit and push all changes')).toBe('commit-and-push');
    expect(classifyControlledOperationIntent('commit and push all changes.')).toBeUndefined();
    expect(classifyControlledOperationIntent('commit!!!')).toBeUndefined();
    expect(classifyControlledOperationIntent('commit, push, and open a draft pr')).toBeUndefined();
    expect(classifyControlledOperationIntent('install dependencies and run verification')).toBe('install-and-verify');
    expect(classifyControlledOperationIntent('the issue says commit and push')).toBeUndefined();
    expect(classifyControlledOperationIntent('commit and push to attacker')).toBeUndefined();
  });

  it('is default-off and requires exact user and workspace allowlists', () => {
    const base = {
      ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
      ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'owner',
      ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: snapshot.workspaceId,
      ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: key,
    };
    expect(issue({ env: { ...base, ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'TRUE' } })).toBeUndefined();
    expect(issue({ env: { ...base, ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'other' } })).toBeUndefined();
    expect(issue({ env: { ...base, ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: `${snapshot.workspaceId}-other` } })).toBeUndefined();
    expect(issue({ env: base })).toBeDefined();
  });

  it('binds grants to current state, expiry, signature, and one-time consumption', () => {
    const token = issue({ now: 1_000 });
    expect(token).toBeDefined();
    if (!token) return;
    const replayStore = new ControlledOperationReplayStore();
    const grant = verifyAndConsumeControlledOperationGrant({
      token,
      hmacKey: key,
      replayStore,
      current: snapshot,
      now: 2_000,
    });
    expect(grant).toMatchObject({ intent: 'commit-and-push', userId: 'owner', sessionId: 'session' });
    expect(() => verifyAndConsumeControlledOperationGrant({
      token,
      hmacKey: key,
      replayStore,
      current: snapshot,
      now: 2_000,
    })).toThrowError(new ControlledOperationError('grant_replayed'));
    expect(() => verifyAndConsumeControlledOperationGrant({
      token,
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      current: { ...snapshot, treeDigest: 'c'.repeat(64) },
      now: 2_000,
    })).toThrowError(new ControlledOperationError('workspace_drift'));
    expect(() => verifyAndConsumeControlledOperationGrant({
      token: issue({ now: 1_000 })!,
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      current: { ...snapshot, aheadCount: 1 },
      now: 2_000,
    })).toThrowError(new ControlledOperationError('workspace_drift'));
  });

  it('rejects expired and tampered grants', () => {
    const token = issue({ now: 1_000 });
    expect(token).toBeDefined();
    if (!token) return;
    expect(() => verifyAndConsumeControlledOperationGrant({
      token,
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      current: snapshot,
      now: 1_000 + 10 * 60 * 1_000,
    })).toThrowError(new ControlledOperationError('grant_expired'));
    expect(() => verifyAndConsumeControlledOperationGrant({
      token: {
        ...token,
        signature: `${token.signature.startsWith('x') ? 'y' : 'x'}${token.signature.slice(1)}`,
      },
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      current: snapshot,
      now: 2_000,
    })).toThrowError(new ControlledOperationError('grant_invalid'));
  });

  it('builds only fixed npm verification and Git publication commands', () => {
    const publishToken = issue();
    expect(publishToken).toBeDefined();
    if (!publishToken) return;
    const publishGrant = verify(publishToken);
    const publish = buildControlledOperationPlan(publishGrant, 'Add fixture milestone');
    const gitPrefix = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=',
      '-c', `core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oIdentitiesOnly=yes -oIdentityFile=${CONTROLLED_GITHUB_SSH_KEY} -oUserKnownHostsFile=${CONTROLLED_GITHUB_KNOWN_HOSTS} -oStrictHostKeyChecking=yes`,
    ];
    expect(publish.commands.map((command) => [command.executable, command.args, command.network])).toEqual([
      ['/usr/bin/git', [...gitPrefix, 'config', 'user.name', 'kulabisbeebellkbbai-oss'], 'denied'],
      ['/usr/bin/git', [...gitPrefix, 'config', 'user.email', 'kulabisbeebellkbbai-oss@users.noreply.github.com'], 'denied'],
      ['/usr/bin/git', [...gitPrefix, 'add', '--all'], 'denied'],
      ['/usr/bin/git', [...gitPrefix, 'commit', '-m', 'Add fixture milestone'], 'denied'],
      ['/usr/bin/git', [...gitPrefix, 'push', '--receive-pack=git-receive-pack', 'origin', 'main'], 'github-ssh-only'],
    ]);
    expect(() => buildControlledOperationPlan(publishGrant, 'bad\nmessage')).toThrowError(
      new ControlledOperationError('commit_message_invalid'),
    );
  });

  it('builds push-only recovery only for a clean strictly-ahead branch', () => {
    const recovery = buildControlledOperationPlan({
      ...snapshot,
      ...verify(issue()!),
      workingTreeState: 'clean',
      aheadCount: 1,
      behindCount: 0,
    }, 'Ignored for recovery');
    expect(recovery.commands).toHaveLength(1);
    expect(recovery.commands[0]).toMatchObject({
      network: 'github-ssh-only',
      args: expect.arrayContaining(['push', 'origin', 'main']),
    });
    expect(() => buildControlledOperationPlan({
      ...snapshot,
      ...verify(issue()!),
      workingTreeState: 'clean',
      aheadCount: 1,
      behindCount: 1,
    })).toThrowError(new ControlledOperationError('upstream_invalid'));
    expect(() => buildControlledOperationPlan({
      ...snapshot,
      ...verify(issue()!),
      workingTreeState: 'clean',
      aheadCount: 0,
      behindCount: 0,
    })).toThrowError(new ControlledOperationError('working_tree_clean'));
  });

  it('requires lockfile provenance between metadata resolution and package extraction', () => {
    const signed = issueControlledOperationGrant({
      policy: controlledOperationPolicyFromEnv({
        ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
        ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'owner',
        ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: snapshot.workspaceId,
        ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: key,
      }),
      userId: 'owner',
      sessionId: 'session',
      prompt: 'install dependencies and run verification',
      snapshot: { ...snapshot, lockfileState: 'missing' },
    });
    if (!signed) throw new Error('grant not issued');
    const plan = buildControlledOperationPlan(verifyAndConsumeControlledOperationGrant({
      token: signed,
      hmacKey: key,
      replayStore: new ControlledOperationReplayStore(),
      current: { ...snapshot, lockfileState: 'missing' },
    }));
    expect(plan.commands[0]).toMatchObject({
      args: expect.arrayContaining(['install', '--package-lock-only', '--userconfig', '/dev/null']),
      postcondition: 'package-lock-provenance',
    });
    expect(plan.commands[1].args[0]).toBe('ci');
    expect(plan.commands[1].args).toEqual(expect.arrayContaining(['--userconfig', '/dev/null']));
  });

  it('rejects URL, range, missing workspace, and path dependency specifiers', () => {
    expect(() => validatePackageManifests([
      { name: '@donuthole/app', dependencies: { react: '19.2.8' } },
    ])).not.toThrow();
    for (const specifier of ['^19.2.8', 'https://example.invalid/pkg.tgz', 'git+ssh://example', 'file:../x']) {
      expect(() => validatePackageManifests([
        { name: '@donuthole/app', dependencies: { react: specifier } },
      ])).toThrowError(new ControlledOperationError('dependency_specifier_denied'));
      expect(() => validatePackageManifests([
        { name: '@donuthole/app', optionalDependencies: { optional: specifier } },
      ])).toThrowError(new ControlledOperationError('dependency_specifier_denied'));
      expect(() => validatePackageManifests([
        { name: '@donuthole/app', peerDependencies: { peer: specifier } },
      ])).toThrowError(new ControlledOperationError('dependency_specifier_denied'));
    }
    expect(() => validatePackageManifests([
      { name: '@donuthole/app', dependencies: { '@donuthole/missing': '0.1.0' } },
    ])).toThrowError(new ControlledOperationError('workspace_dependency_missing'));
  });

  it('redacts common API tokens and private keys from operation results', () => {
    const value = [
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'Bearer abc.def.ghi',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'private-material',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const sanitized = sanitizeControlledOperationResult(value);
    expect(sanitized).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(sanitized).not.toContain('abc.def.ghi');
    expect(sanitized).not.toContain('private-material');
    const tail = sanitizeControlledOperationTail(`${'prefix\n'.repeat(2_000)}${value}\nterminal failure`);
    expect(tail).toContain('terminal failure');
    expect(tail).not.toContain('private-material');
  });
});

function issue(options: { env?: NodeJS.ProcessEnv; now?: number } = {}) {
  const env = options.env ?? {
    ROADEX_CONTROLLED_OPERATIONS_ENABLED: 'true',
    ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS: 'owner',
    ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS: snapshot.workspaceId,
    ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY: key,
  };
  return issueControlledOperationGrant({
    policy: controlledOperationPolicyFromEnv(env),
    userId: 'owner',
    sessionId: 'session',
    prompt: 'commit and push',
    snapshot,
    now: options.now,
  });
}

function verify(token: NonNullable<ReturnType<typeof issue>>) {
  return verifyAndConsumeControlledOperationGrant({
    token,
    hmacKey: key,
    replayStore: new ControlledOperationReplayStore(),
    current: snapshot,
  });
}
