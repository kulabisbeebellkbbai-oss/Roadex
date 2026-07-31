import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const CONTROLLED_OPERATIONS_PROFILE = 'roadex-controlled-operations-v1';
export const CONTROLLED_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const CONTROLLED_GITHUB_SSH_KEY =
  '/home/god/.local/share/roadex-controlled-operations/ssh/id_ed25519';
export const CONTROLLED_GITHUB_KNOWN_HOSTS =
  '/home/god/.local/share/roadex-controlled-operations/ssh/known_hosts';
export const CONTROLLED_OPERATION_MAX_AGE_MS = 10 * 60 * 1_000;

export type ControlledOperationIntent =
  | 'install-and-verify'
  | 'commit'
  | 'commit-and-push';

export type ControlledWorkspaceSnapshot = {
  workspaceId: string;
  workspaceRoot: string;
  managedThreadId: string;
  repository: string;
  remote: string;
  branch: string;
  headCommit: string;
  upstreamRef?: string;
  upstreamCommit?: string;
  workingTreeState: 'clean' | 'dirty';
  aheadCount: number;
  behindCount: number;
  treeDigest: string;
  manifestDigest?: string;
  lockfileState: 'missing' | 'validated';
  visibility: 'private' | 'public';
};

export type ControlledOperationGrant = ControlledWorkspaceSnapshot & {
  version: 1;
  profile: typeof CONTROLLED_OPERATIONS_PROFILE;
  operationId: string;
  nonce: string;
  userId: string;
  sessionId: string;
  intent: ControlledOperationIntent;
  issuedAt: string;
  expiresAt: string;
};

export type SignedControlledOperationGrant = {
  payload: string;
  signature: string;
};

export type ControlledOperationPolicy = {
  enabled: boolean;
  authorizedUsers: Set<string>;
  authorizedWorkspaces: Set<string>;
  hmacKey?: string;
};

export type ControlledCommand = {
  executable: string;
  args: string[];
  network: 'denied' | 'npm-registry-only' | 'github-ssh-only';
  timeoutMs: number;
  maxOutputBytes: number;
  postcondition?: 'package-lock-provenance';
};

export type ControlledOperationPlan = {
  operationId: string;
  intent: ControlledOperationIntent;
  workspaceRoot: string;
  commands: ControlledCommand[];
};

export class ControlledOperationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class ControlledOperationReplayStore {
  private readonly consumed = new Set<string>();

  consume(nonce: string): boolean {
    if (this.consumed.has(nonce)) return false;
    this.consumed.add(nonce);
    return true;
  }
}

export type ControlledOperationReplayStoreLike = {
  consume: (nonce: string) => boolean;
};

export function controlledOperationPolicyFromEnv(env: NodeJS.ProcessEnv): ControlledOperationPolicy {
  return {
    enabled: env.ROADEX_CONTROLLED_OPERATIONS_ENABLED === 'true',
    authorizedUsers: exactAllowlist(env.ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS),
    authorizedWorkspaces: exactAllowlist(env.ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS),
    hmacKey: env.ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY,
  };
}

export function classifyControlledOperationIntent(prompt: string): ControlledOperationIntent | undefined {
  const normalized = prompt.trim().toLowerCase();
  if (normalized === 'install dependencies and run verification') return 'install-and-verify';
  if (normalized === 'commit') return 'commit';
  if (normalized === 'commit and push' || normalized === 'commit and push all changes') return 'commit-and-push';
  return undefined;
}

export function issueControlledOperationGrant(input: {
  policy: ControlledOperationPolicy;
  userId: string;
  sessionId: string;
  prompt: string;
  snapshot: ControlledWorkspaceSnapshot;
  now?: number;
}): SignedControlledOperationGrant | undefined {
  const intent = classifyControlledOperationIntent(input.prompt);
  if (!intent || !input.policy.enabled) return undefined;
  if (!input.policy.authorizedUsers.has(input.userId)) return undefined;
  if (!input.policy.authorizedWorkspaces.has(input.snapshot.workspaceId)) return undefined;
  const key = requireHmacKey(input.policy.hmacKey);
  validateSnapshot(input.snapshot);
  const now = input.now ?? Date.now();
  const grant: ControlledOperationGrant = {
    ...input.snapshot,
    version: 1,
    profile: CONTROLLED_OPERATIONS_PROFILE,
    operationId: `controlled-operation-${randomUUID()}`,
    nonce: randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    intent,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONTROLLED_OPERATION_MAX_AGE_MS).toISOString(),
  };
  return signGrant(grant, key);
}

export function verifyAndConsumeControlledOperationGrant(input: {
  token: SignedControlledOperationGrant;
  hmacKey: string | undefined;
  replayStore: ControlledOperationReplayStoreLike;
  current: ControlledWorkspaceSnapshot;
  now?: number;
}): ControlledOperationGrant {
  const grant = verifyControlledOperationGrant({
    token: input.token,
    hmacKey: input.hmacKey,
    current: input.current,
    now: input.now,
  });
  if (!input.replayStore.consume(grant.nonce)) throw new ControlledOperationError('grant_replayed');
  return grant;
}

export function verifyControlledOperationGrant(input: {
  token: SignedControlledOperationGrant;
  hmacKey: string | undefined;
  current: ControlledWorkspaceSnapshot;
  now?: number;
}): ControlledOperationGrant {
  const grant = authenticateControlledOperationGrant({
    token: input.token,
    hmacKey: input.hmacKey,
    now: input.now,
  });
  validateSnapshot(input.current);
  for (const field of [
    'workspaceId', 'workspaceRoot', 'managedThreadId', 'repository',
    'remote', 'branch', 'headCommit', 'upstreamRef', 'upstreamCommit',
    'workingTreeState', 'aheadCount', 'behindCount', 'treeDigest',
    'manifestDigest', 'lockfileState', 'visibility',
  ] as const) {
    if (grant[field] !== input.current[field]) throw new ControlledOperationError('workspace_drift');
  }
  return grant;
}

export function authenticateControlledOperationGrant(input: {
  token: SignedControlledOperationGrant;
  hmacKey: string | undefined;
  now?: number;
}): ControlledOperationGrant {
  const key = requireHmacKey(input.hmacKey);
  const expected = createHmac('sha256', key).update(input.token.payload).digest('base64url');
  const supplied = Buffer.from(input.token.signature);
  const expectedBuffer = Buffer.from(expected);
  if (supplied.length !== expectedBuffer.length || !timingSafeEqual(supplied, expectedBuffer)) {
    throw new ControlledOperationError('grant_invalid');
  }
  let grant: ControlledOperationGrant;
  try {
    grant = JSON.parse(Buffer.from(input.token.payload, 'base64url').toString('utf8')) as ControlledOperationGrant;
  } catch {
    throw new ControlledOperationError('grant_invalid');
  }
  if (grant.version !== 1 || grant.profile !== CONTROLLED_OPERATIONS_PROFILE) {
    throw new ControlledOperationError('grant_invalid');
  }
  const now = input.now ?? Date.now();
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || issuedAt > now
    || expiresAt - issuedAt > CONTROLLED_OPERATION_MAX_AGE_MS
  ) {
    throw new ControlledOperationError('grant_expired');
  }
  if (
    !/^controlled-operation-[0-9a-f-]{36}$/.test(grant.operationId)
    || !/^[0-9a-f-]{36}$/.test(grant.nonce)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(grant.userId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(grant.sessionId)
    || !['install-and-verify', 'commit', 'commit-and-push'].includes(grant.intent)
  ) throw new ControlledOperationError('grant_invalid');
  validateSnapshot(grant);
  return grant;
}

export function encodeSignedControlledOperationGrant(token: SignedControlledOperationGrant): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

export function decodeSignedControlledOperationGrant(value: string): SignedControlledOperationGrant {
  if (!/^[A-Za-z0-9_-]{20,16000}$/.test(value)) throw new ControlledOperationError('grant_invalid');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SignedControlledOperationGrant;
    if (
      !parsed
      || typeof parsed.payload !== 'string'
      || typeof parsed.signature !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(parsed.payload)
      || !/^[A-Za-z0-9_-]+$/.test(parsed.signature)
    ) throw new Error('invalid');
    return parsed;
  } catch {
    throw new ControlledOperationError('grant_invalid');
  }
}

export function buildControlledOperationPlan(
  grant: ControlledOperationGrant,
  commitMessage = 'Update project',
): ControlledOperationPlan {
  const safeMessage = validateCommitMessage(commitMessage);
  const verificationScripts = ['format:check', 'typecheck', 'lint', 'test', 'test:coverage', 'build'];
  const commands: ControlledCommand[] = [];
  if (grant.intent === 'install-and-verify') {
    if (grant.lockfileState === 'missing') {
      commands.push({
        executable: '/home/god/.local/bin/npm',
        args: [
          'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
          '--registry', CONTROLLED_NPM_REGISTRY, '--userconfig', '/dev/null',
        ],
        network: 'npm-registry-only',
        timeoutMs: 300_000,
        maxOutputBytes: 256_000,
        postcondition: 'package-lock-provenance',
      });
    }
    commands.push({
      executable: '/home/god/.local/bin/npm',
      args: [
        'ci', '--ignore-scripts', '--no-audit', '--no-fund',
        '--registry', CONTROLLED_NPM_REGISTRY, '--userconfig', '/dev/null',
      ],
      network: 'npm-registry-only',
      timeoutMs: 300_000,
      maxOutputBytes: 256_000,
    });
    for (const script of verificationScripts) {
      commands.push({
        executable: '/home/god/.local/bin/npm',
        args: ['run', script],
        network: 'denied',
        timeoutMs: 300_000,
        maxOutputBytes: 256_000,
      });
    }
  } else {
    if (grant.intent === 'commit-and-push' && (
      !grant.upstreamRef
      || grant.behindCount !== 0
    )) throw new ControlledOperationError('upstream_invalid');
    if (grant.workingTreeState === 'dirty') {
      commands.push(
        fixedGit(['config', 'user.name', 'kulabisbeebellkbbai-oss']),
        fixedGit(['config', 'user.email', 'kulabisbeebellkbbai-oss@users.noreply.github.com']),
        fixedGit(['add', '--all']),
        fixedGit(['commit', '-m', safeMessage]),
      );
    } else if (grant.intent === 'commit' || grant.aheadCount < 1) {
      throw new ControlledOperationError('working_tree_clean');
    }
    if (grant.intent !== 'commit') {
      commands.push({
        ...fixedGit(['push', '--receive-pack=git-receive-pack', 'origin', grant.branch]),
        network: 'github-ssh-only',
        timeoutMs: 120_000,
      });
    }
  }
  return {
    operationId: grant.operationId,
    intent: grant.intent,
    workspaceRoot: grant.workspaceRoot,
    commands,
  };
}

export function validatePackageManifests(
  manifests: Array<{
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }>,
): void {
  if (!manifests.length || manifests.length > 64) throw new ControlledOperationError('manifest_invalid');
  const workspaceNames = new Set(manifests.map((manifest) => manifest.name).filter(Boolean));
  for (const manifest of manifests) {
    for (const [name, specifier] of Object.entries({
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    })) {
      if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(specifier)) {
        throw new ControlledOperationError('dependency_specifier_denied');
      }
      if (name.startsWith('@donuthole/') && !workspaceNames.has(name)) {
        throw new ControlledOperationError('workspace_dependency_missing');
      }
    }
  }
}

export function sanitizeControlledOperationResult(value: string): string {
  return redactControlledOperationResult(value).slice(0, 12_000);
}

export function sanitizeControlledOperationTail(value: string): string {
  return redactControlledOperationResult(value).slice(-6_000);
}

function redactControlledOperationResult(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted-token]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]');
}

function signGrant(grant: ControlledOperationGrant, key: string): SignedControlledOperationGrant {
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return {
    payload,
    signature: createHmac('sha256', key).update(payload).digest('base64url'),
  };
}

function fixedGit(args: string[]): ControlledCommand {
  return {
    executable: '/usr/bin/git',
    args: [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=',
      '-c', `core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oIdentitiesOnly=yes -oIdentityFile=${CONTROLLED_GITHUB_SSH_KEY} -oUserKnownHostsFile=${CONTROLLED_GITHUB_KNOWN_HOSTS} -oStrictHostKeyChecking=yes`,
      ...args,
    ],
    network: 'denied',
    timeoutMs: 30_000,
    maxOutputBytes: 128_000,
  };
}

function validateSnapshot(snapshot: ControlledWorkspaceSnapshot): void {
  if (!snapshot.workspaceRoot.startsWith('/') || snapshot.workspaceRoot.includes('\0')) {
    throw new ControlledOperationError('workspace_invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshot.workspaceId)) {
    throw new ControlledOperationError('workspace_invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshot.managedThreadId)) {
    throw new ControlledOperationError('thread_invalid');
  }
  if (!/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(snapshot.remote)) {
    throw new ControlledOperationError('remote_denied');
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.repository)
    || snapshot.remote !== `git@github.com:${snapshot.repository}.git`
  ) throw new ControlledOperationError('repository_invalid');
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(snapshot.branch) || snapshot.branch.includes('..')) {
    throw new ControlledOperationError('branch_invalid');
  }
  if (!/^[a-f0-9]{40,64}$/.test(snapshot.headCommit)) {
    throw new ControlledOperationError('commit_invalid');
  }
  if (
    (snapshot.upstreamRef === undefined) !== (snapshot.upstreamCommit === undefined)
    || (snapshot.upstreamRef !== undefined
      && snapshot.upstreamRef !== `refs/remotes/origin/${snapshot.branch}`)
    || (snapshot.upstreamCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(snapshot.upstreamCommit))
  ) throw new ControlledOperationError('upstream_invalid');
  if (snapshot.workingTreeState !== 'clean' && snapshot.workingTreeState !== 'dirty') {
    throw new ControlledOperationError('workspace_invalid');
  }
  if (
    !Number.isSafeInteger(snapshot.aheadCount)
    || snapshot.aheadCount < 0
    || snapshot.aheadCount > 10_000
    || !Number.isSafeInteger(snapshot.behindCount)
    || snapshot.behindCount < 0
    || snapshot.behindCount > 10_000
    || (!snapshot.upstreamRef && (snapshot.aheadCount !== 0 || snapshot.behindCount !== 0))
  ) throw new ControlledOperationError('upstream_invalid');
  if (!/^[a-f0-9]{64}$/.test(snapshot.treeDigest)) throw new ControlledOperationError('digest_invalid');
  if (snapshot.manifestDigest && !/^[a-f0-9]{64}$/.test(snapshot.manifestDigest)) {
    throw new ControlledOperationError('digest_invalid');
  }
  if (snapshot.lockfileState !== 'missing' && snapshot.lockfileState !== 'validated') {
    throw new ControlledOperationError('lockfile_invalid');
  }
  if (snapshot.visibility !== 'private' && snapshot.visibility !== 'public') {
    throw new ControlledOperationError('visibility_invalid');
  }
}

function validateCommitMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized || normalized.length > 72 || /[\r\n\0]/.test(normalized)) {
    throw new ControlledOperationError('commit_message_invalid');
  }
  return normalized;
}

function requireHmacKey(key: string | undefined): string {
  if (!key || Buffer.byteLength(key) < 32) throw new ControlledOperationError('broker_disabled');
  return key;
}

function exactAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '').split(',').map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(entry)),
  );
}
