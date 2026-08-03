import { describe, expect, it } from 'vitest';
import {
  ACTIVE_APPROVAL_WAIT_STATES,
  consoleForAuthority,
  isActiveApprovalWait,
  type ApprovalWaitState,
} from '../src/shared/approvalWorkflowContracts';

describe('approval workflow contracts', () => {
  it('maps authority to a server-owned console surface', () => {
    expect(consoleForAuthority('privileged-operation')).toBe('admin');
    expect(consoleForAuthority('project-workflow')).toBe('overview');
  });

  it('keeps only executable wait states active', () => {
    expect(isActiveApprovalWait('pending')).toBe(true);
    expect(isActiveApprovalWait('resume-reconciliation-required')).toBe(true);
    expect(isActiveApprovalWait('rejected')).toBe(false);
    expect(isActiveApprovalWait('resumed')).toBe(false);
  });

  it('classifies all approval wait states exactly once as active or terminal', () => {
    const allStates: ApprovalWaitState[] = [
      'pending',
      'verification-delayed',
      'security-failure',
      'changes-requested',
      'rejected',
      'expired',
      'revoked',
      'approved-resume-queued',
      'resume-dispatching',
      'resume-reconciliation-required',
      'resumed',
      'session-closed',
    ];
    const activeStates = allStates.filter((value) => isActiveApprovalWait(value));
    const terminalStates = allStates.filter((value) => !isActiveApprovalWait(value));

    expect(activeStates.sort()).toEqual([...ACTIVE_APPROVAL_WAIT_STATES].sort());
    for (const state of activeStates) {
      expect(terminalStates).not.toContain(state);
    }
  });
});
