import { describe, expect, it } from 'vitest';
import { consoleForAuthority, isActiveApprovalWait } from '../src/shared/approvalWorkflowContracts';

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
});
