import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_APPROVAL_WAIT_STATES,
  consoleForAuthority,
  isActiveApprovalWait,
  parsePsychloPolicyExceptionFixture,
  projectPsychloPolicyException,
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

  it('parses the frozen Psychlo policy exception fixture and projects a read-only overview authority', () => {
    const fixture = JSON.parse(readFileSync(
      '/home/god/Documents/Codex Workspace/Overseer/.worktrees/psychlo-v1-1-counterpart/tests/fixtures/psychlo-v1-1-policy-exception.json',
      'utf8',
    ));
    const parsed = parsePsychloPolicyExceptionFixture(fixture);

    expect(parsed.request.digest).toBe('c01fdef45590e31a57d9974e7a20a58924f691ebd9b2ac9a2d3277d04f49587a');
    expect(parsed.outcome?.status).toBe('approved');
    expect(parsed.usageSnapshot.snapshot.weeklyQuota).toBe(700);
    expect(projectPsychloPolicyException(parsed, new Date('2026-08-12T18:00:00.000Z'))).toMatchObject({
      ruleId: 'enforce-safety-reserve',
      priorPolicyRevision: 4,
      requestedValue: false,
      status: 'approved',
      consoleSurface: 'overview',
      consolePath: '/Overseer/overview',
    });
  });

  it('rejects altered, unknown, or unsafe fields in the frozen fixture', () => {
    const fixture = JSON.parse(readFileSync(
      '/home/god/Documents/Codex Workspace/Overseer/.worktrees/psychlo-v1-1-counterpart/tests/fixtures/psychlo-v1-1-policy-exception.json',
      'utf8',
    ));
    expect(() => parsePsychloPolicyExceptionFixture({ ...fixture, extra: true })).toThrow();
    expect(() => parsePsychloPolicyExceptionFixture({
      ...fixture,
      request: { ...fixture.request, reason: '<script>alert(1)</script>' },
    })).toThrow();
    expect(() => parsePsychloPolicyExceptionFixture({
      ...fixture,
      outcome: { ...fixture.outcome, requestDigest: '0'.repeat(64) },
    })).toThrow();
  });

  it('projects pending and expired outcomes without granting mutation authority', () => {
    const fixture = JSON.parse(readFileSync(
      '/home/god/Documents/Codex Workspace/Overseer/.worktrees/psychlo-v1-1-counterpart/tests/fixtures/psychlo-v1-1-policy-exception.json',
      'utf8',
    ));
    const requestOnly = parsePsychloPolicyExceptionFixture({ ...fixture, outcome: undefined });
    expect(projectPsychloPolicyException(requestOnly, new Date('2026-08-12T18:00:00.000Z'))).toMatchObject({ status: 'pending' });
    expect(projectPsychloPolicyException(requestOnly, new Date('2026-08-13T00:00:00.000Z'))).toMatchObject({ status: 'expired' });
    expect(projectPsychloPolicyException(requestOnly, new Date('2026-08-12T18:00:00.000Z'))).not.toHaveProperty('approve');
  });
});
