export type ApprovalAuthorityClass = 'privileged-operation' | 'project-workflow';

export type ApprovalConsoleSurface = 'admin' | 'overview';

export type ApprovalDecision = 'pending' | 'approved' | 'changes-requested' | 'rejected' | 'expired' | 'revoked';

export type ApprovalProvider = 'overseer';

export type ApprovalWaitState =
  | 'pending'
  | 'verification-delayed'
  | 'security-failure'
  | 'changes-requested'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'approved-resume-queued'
  | 'resume-dispatching'
  | 'resume-reconciliation-required'
  | 'resumed'
  | 'session-closed';

export type NormalizedApprovalStatus = {
  provider: ApprovalProvider;
  approvalRef: string;
  authorityClass: ApprovalAuthorityClass;
  decision: ApprovalDecision;
  decisionVersion: string;
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  subject: string;
  updatedAt: string;
};

export type RoadexApprovalStatusProjection = {
  approvalRef: string;
  sourceKind: 'admin-plan' | 'roadex-human-decision';
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  authorityClass: ApprovalAuthorityClass;
  subject: string;
  scopeDigest: string;
  decision: ApprovalDecision;
  decisionVersion: string;
  updatedAt: string;
};

export type ApprovalWaitRecord = {
  id: string;
  sessionId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  managedThreadId: string;
  provider: ApprovalProvider;
  approvalRef: string;
  resourceRef: string;
  authorityClass: ApprovalAuthorityClass;
  consoleSurface: ApprovalConsoleSurface;
  subject: string;
  state: ApprovalWaitState;
  decisionVersion: string;
  continuationId: string;
  checkAttempt: number;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
  decisionObservedAt?: string;
  dispatchReservedAt?: string;
  runnerRunId?: string;
  resumedAt?: string;
};

export type WaitingApprovalSummary = {
  waitId: string;
  approvalRef: string;
  subject: string;
  consoleSurface: ApprovalConsoleSurface;
  consolePath?: string;
  state:
    | 'pending'
    | 'verification-delayed'
    | 'security-failure'
    | 'approved-resume-queued'
    | 'resume-dispatching'
    | 'resume-reconciliation-required';
  updatedAt: string;
};

export const ACTIVE_APPROVAL_WAIT_STATES = new Set<ApprovalWaitState>([
  'pending',
  'verification-delayed',
  'security-failure',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
]);

export function consoleForAuthority(value: ApprovalAuthorityClass): ApprovalConsoleSurface {
  return value === 'privileged-operation' ? 'admin' : 'overview';
}

export function isActiveApprovalWait(value: ApprovalWaitState): boolean {
  return ACTIVE_APPROVAL_WAIT_STATES.has(value);
}
