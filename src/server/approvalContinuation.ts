import type { ApprovalWaitRecord } from '../shared/approvalWorkflowContracts.js';

const APPROVAL_REFERENCE_MAX = 256;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isSafeSingleLineOpaque(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > APPROVAL_REFERENCE_MAX) {
    return false;
  }
  if (value.trim() !== value) {
    return false;
  }
  return !/[\r\n]/.test(value);
}

export function buildApprovalContinuation(wait: ApprovalWaitRecord): string {
  if (!isSafeSingleLineOpaque(wait.approvalRef) || !SHA256_PATTERN.test(wait.decisionVersion)) {
    throw new Error('Invalid approval continuation input');
  }

  return [
    '[Roadex verified human approval]',
    `Approval reference: ${wait.approvalRef}`,
    `Decision version: ${wait.decisionVersion}`,
    'Continue the previously paused workflow within the exact approved scope.',
    'Do not broaden the approved operation or infer approval for another gate.',
  ].join('\n');
}
