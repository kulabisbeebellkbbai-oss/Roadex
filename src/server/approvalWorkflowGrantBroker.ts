import { createHash, randomBytes } from 'node:crypto';

export type ApprovalWorkflowGrant = {
  token: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  managedThreadId: string;
  runId: string;
  expiresAt: string;
};

const APPROVAL_WORKFLOW_TOKEN_TTL_MS = 5 * 60 * 1_000;
const APPROVAL_WORKFLOW_TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,16000}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

type ApprovalWorkflowGrantInput = Omit<ApprovalWorkflowGrant, 'token' | 'expiresAt'>;
type ApprovalWorkflowGrantOptions = {
  now?: () => number;
};

type StoredWorkflowGrant = Omit<ApprovalWorkflowGrant, 'token'>;

export class ApprovalWorkflowGrantBroker {
  private readonly grants = new Map<string, StoredWorkflowGrant>();
  private readonly now: () => number;

  constructor(options: ApprovalWorkflowGrantOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  issue(input: ApprovalWorkflowGrantInput): ApprovalWorkflowGrant {
    if (!this.isValidBinding(input)) {
      throw new Error('workflow_grant_invalid');
    }
    this.purgeExpired();
    const token = randomBytes(32).toString('base64url');
    if (!APPROVAL_WORKFLOW_TOKEN_PATTERN.test(token)) {
      throw new Error('workflow_grant_internal');
    }
    const grant: ApprovalWorkflowGrant = {
      ...input,
      token,
      expiresAt: new Date(this.now() + APPROVAL_WORKFLOW_TOKEN_TTL_MS).toISOString(),
    };
    this.grants.set(this.tokenDigest(token), {
      userId: grant.userId,
      sessionId: grant.sessionId,
      workspaceId: grant.workspaceId,
      managedThreadId: grant.managedThreadId,
      runId: grant.runId,
      expiresAt: grant.expiresAt,
    });
    return grant;
  }

  consume(token: string): ApprovalWorkflowGrant | undefined {
    this.purgeExpired();
    if (!APPROVAL_WORKFLOW_TOKEN_PATTERN.test(token)) return undefined;
    const key = this.tokenDigest(token);
    const grant = this.grants.get(key);
    this.grants.delete(key);
    if (!grant) return undefined;
    return {
      ...grant,
      token,
    };
  }

  revokeRun(runId: string): void {
    for (const [digest, grant] of this.grants) {
      if (grant.runId === runId) {
        this.grants.delete(digest);
      }
    }
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [digest, grant] of this.grants) {
      const expiry = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now) {
        this.grants.delete(digest);
      }
    }
  }

  private isValidBinding(input: ApprovalWorkflowGrantInput): boolean {
    return (
      USER_ID_PATTERN.test(input.userId)
      && SESSION_ID_PATTERN.test(input.sessionId)
      && WORKSPACE_ID_PATTERN.test(input.workspaceId)
      && SESSION_ID_PATTERN.test(input.managedThreadId)
      && RUN_ID_PATTERN.test(input.runId)
    );
  }

  private tokenDigest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
