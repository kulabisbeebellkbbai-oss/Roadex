import type {
  ApprovalConsoleSurface,
  WaitingApprovalSummary,
} from '../shared/approvalWorkflowContracts';

export function approvalWaitBodyCopy(wait: WaitingApprovalSummary): {
  primary: string;
  secondary: string;
} {
  const consoleLabel = wait.consoleSurface === 'admin' ? 'Admin Console' : 'Overview Console';
  switch (wait.state) {
    case 'pending':
      return {
        primary: `Approve ${wait.subject} in the ${consoleLabel}.`,
        secondary: 'Roadex will continue automatically after approval is verified.',
      };
    case 'verification-delayed':
      return {
        primary: `Approval verification is delayed in the ${consoleLabel}. This thread remains safely paused.`,
        secondary: 'Roadex is retrying verification; do not submit a second approval.',
      };
    case 'approved-resume-queued':
      return {
        primary: `Approval was granted in the ${consoleLabel}.`,
        secondary: 'Roadex is waiting for runner capacity before continuing.',
      };
    case 'resume-dispatching':
      return {
        primary: `Approval was granted in the ${consoleLabel}.`,
        secondary: 'The continuation is being delivered to the managed thread.',
      };
    case 'security-failure':
      return {
        primary: `Approval security verification failed for ${wait.subject}.`,
        secondary: `Roadex remains safely paused for manual review in the ${consoleLabel}.`,
      };
    case 'resume-reconciliation-required':
      return {
        primary: `Approval remains recorded in the ${consoleLabel}.`,
        secondary: 'An operator must verify whether the exact continuation was accepted before Roadex can proceed.',
      };
  }
}

export function approvalWaitStatusCopy(state: WaitingApprovalSummary['state']): string {
  switch (state) {
    case 'pending':
      return 'Waiting for human approval.';
    case 'verification-delayed':
      return 'Approval verification is delayed. Roadex remains safely paused.';
    case 'security-failure':
      return 'Approval verification failed security checks. Manual review is required.';
    case 'approved-resume-queued':
      return 'Approval verified. Continuation is queued for runner capacity.';
    case 'resume-dispatching':
      return 'Approval verified. Roadex is dispatching the continuation.';
    case 'resume-reconciliation-required':
      return 'Continuation status is uncertain. Reconciliation is required.';
  }
}

export function safeApprovalConsolePath(
  surface: ApprovalConsoleSurface,
  path: string | undefined,
): string | undefined {
  const allowlisted = surface === 'admin' ? '/Overseer/admin' : '/Overseer/overview';
  return path === allowlisted ? path : undefined;
}
