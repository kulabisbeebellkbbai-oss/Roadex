import { createHash, randomBytes } from 'node:crypto';

const APPROVAL_WORKFLOW_MAX_AGE_MS = 5 * 60 * 1_000;

export type ApprovalWorkflowGrant = {
  token: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  managedThreadId: string;
  runId: string;
  expiresAt: string;
};

type StoredApprovalWorkflowGrant = Omit<ApprovalWorkflowGrant, 'token'>;

type ApprovalWorkflowGrantBrokerOptions = {
  now?: () => number;
};

export class ApprovalWorkflowGrantBroker {
  readonly #now: () => number;
  readonly #grants: Map<string, StoredApprovalWorkflowGrant>;
  readonly #grantsByRun: Map<string, Set<string>>;

  constructor(options: ApprovalWorkflowGrantBrokerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#grants = new Map();
    this.#grantsByRun = new Map();
  }

  issue(scope: Omit<ApprovalWorkflowGrant, 'token' | 'expiresAt'>): ApprovalWorkflowGrant {
    if (
      !isSafeField(scope.userId, /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/)
      || !isSafeField(scope.sessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
      || !isSafeField(scope.workspaceId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
      || !isSafeField(scope.managedThreadId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
      || !isSafeField(scope.runId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
    ) throw new Error('approval_workflow_grant_scope_invalid');

    const now = this.#now();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + APPROVAL_WORKFLOW_MAX_AGE_MS).toISOString();
    const digest = digestToken(token);
    this.#pruneExpired(now);
    this.#grants.set(digest, {
      userId: scope.userId,
      sessionId: scope.sessionId,
      workspaceId: scope.workspaceId,
      managedThreadId: scope.managedThreadId,
      runId: scope.runId,
      expiresAt,
    });
    const byRun = this.#grantsByRun.get(scope.runId) ?? new Set();
    byRun.add(digest);
    this.#grantsByRun.set(scope.runId, byRun);

    return {
      ...scope,
      token,
      expiresAt,
    };
  }

  consume(token: string): ApprovalWorkflowGrant | undefined {
    if (!isSafeField(token, /^[A-Za-z0-9_-]{20,16000}$/)) return undefined;
    const digest = digestToken(token);
    const grant = this.#grants.get(digest);
    if (!grant) return undefined;
    this.#grants.delete(digest);
    const byRun = this.#grantsByRun.get(grant.runId);
    if (byRun) {
      byRun.delete(digest);
      if (byRun.size === 0) this.#grantsByRun.delete(grant.runId);
    }

    const now = this.#now();
    if (Date.parse(grant.expiresAt) <= now) return undefined;
    return {
      ...grant,
      token,
    };
  }

  revokeRun(runId: string): void {
    const digests = this.#grantsByRun.get(runId);
    if (!digests) return;
    for (const digest of digests) {
      this.#grants.delete(digest);
    }
    this.#grantsByRun.delete(runId);
  }

  #pruneExpired(now: number): void {
    for (const [digest, grant] of this.#grants) {
      if (Date.parse(grant.expiresAt) <= now) {
        this.#grants.delete(digest);
        const byRun = this.#grantsByRun.get(grant.runId);
        byRun?.delete(digest);
        if (byRun && byRun.size === 0) this.#grantsByRun.delete(grant.runId);
      }
    }
  }
}

function isSafeField(value: string, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
