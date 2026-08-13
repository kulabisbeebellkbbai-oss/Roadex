import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_APPROVAL_WAIT_STATES,
  consoleForAuthority,
  isActiveApprovalWait,
  parsePsychloPolicyExceptionFixture,
  projectPsychloPolicyException,
  canonicalPsychloPolicyDigest,
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
      'tests/fixtures/psychlo-v1-1-policy-exception.json',
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
      'tests/fixtures/psychlo-v1-1-policy-exception.json',
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
      'tests/fixtures/psychlo-v1-1-policy-exception.json',
      'utf8',
    ));
    const requestOnly = parsePsychloPolicyExceptionFixture({ ...fixture, outcome: undefined });
    expect(projectPsychloPolicyException(requestOnly, new Date('2026-08-12T18:00:00.000Z'))).toMatchObject({ status: 'pending' });
    expect(projectPsychloPolicyException(requestOnly, new Date('2026-08-13T00:00:00.000Z'))).toMatchObject({ status: 'expired' });
    expect(projectPsychloPolicyException(requestOnly, new Date('2026-08-12T18:00:00.000Z'))).not.toHaveProperty('approve');
  });

  it('matches Overseer binary64 requestedValue parity vectors without changing wire values', () => {
    const base = {
      schemaVersion: 'psychlo.policy-exception-request.v1',
      id: 'exception-vector', requestedRuleId: 'enforce-safety-reserve', policyRevision: 4,
      actorId: 'operator-1', reason: 'bounded safety drill',
      activatedAt: '2026-08-12T12:00:00.000Z', expiresAt: '2026-08-13T00:00:00.000Z',
      correlationId: 'corr-vector', idempotencyKey: 'key-vector',
      occurredAt: '2026-08-12T12:00:00.000Z', scopeDigest: 'e'.repeat(64), decisionVersion: 'decision-v1',
    } as Record<string, unknown>;
    const expected: Record<string, string> = {
      true: 'f4df4ccdfb1e6a794204fee8b2c2543d457e1a1099fbcdd486fa9a5edce80310',
      '1': '99987ff22f6311f73a32a7ebadc3939bdaec14077d5f62cb9bbcf86f7c575112',
      '-0': '8a01b71b6b00a8ee7582a6e5cbab913b72fbda826b866315c2edc9f414169dbf',
      '0.125': '175aa0c8b0a942f21509ab6c555787815f046cf6c121b4e718d23986ddca31a4',
      '1e-7': '607cdfba0c6a1ff8793472956639b08f8cfbb0ad2a509672679b21ccc2991744',
    };
    for (const [label, value] of [['true', true], ['1', 1], ['1.0', 1.0], ['-0', -0], ['0.125', 0.125], ['1e-7', 1e-7]] as const) {
      const request = { ...base, requestedValue: value };
      expect(canonicalPsychloPolicyDigest(request)).toBe(expected[label === '1.0' ? '1' : label]);
      expect(request.requestedValue).toBe(value);
    }
  });

  it('requires exactly one scalar or proposed-policy form and enforces all nine rules', () => {
    const fixture = JSON.parse(readFileSync(
      'tests/fixtures/psychlo-v1-1-policy-exception.json',
      'utf8',
    ));
    const rules = Object.fromEntries([
      'reset-daily-at-provider-reset', 'count-other-development', 'enforce-provider-quota', 'enforce-safety-reserve',
      'respect-blackouts', 'carry-unused-daily-allowance', 'pause-after-failures', 'require-manual-resume', 'enforce-project-share',
    ].map((rule) => [rule, true]));
    for (const requestedRuleId of Object.keys(rules)) {
      const request = { ...fixture.request, requestedRuleId, digest: '' } as Record<string, unknown>;
      request.digest = canonicalPsychloPolicyDigest(request);
      expect(parsePsychloPolicyExceptionFixture({ ...fixture, request, outcome: undefined }).request.requestedRuleId).toBe(requestedRuleId);
    }
    const proposedPolicy = {
      schemaVersion: 'psychlo.policy.v1', id: 'policy-next', revision: 5,
      dailyQuotaPercent: 80, safetyReservePercent: 20, projectShares: { 'project-1': 50 }, failurePauseThreshold: 3,
      rules, operatingEnvelope: { maxDailyQuotaPercent: 90, minSafetyReservePercent: 10 }, actorId: 'operator-1',
      correlationId: 'policy-corr', idempotencyKey: 'policy-key', occurredAt: '2026-08-12T12:00:00.000Z', digest: '',
    } as Record<string, unknown>;
    proposedPolicy.digest = canonicalPsychloPolicyDigest(proposedPolicy);
    const proposedRequest = { ...fixture.request, requestedValue: undefined, basePolicyDigest: 'b'.repeat(64), proposedPolicy, digest: '' } as Record<string, unknown>;
    delete proposedRequest.requestedValue;
    proposedRequest.digest = canonicalPsychloPolicyDigest(proposedRequest);
    const parsed = parsePsychloPolicyExceptionFixture({ ...fixture, request: proposedRequest, outcome: undefined });
    expect(parsed.request).toHaveProperty('proposedPolicy');
    expect(() => parsePsychloPolicyExceptionFixture({ ...fixture, request: { ...fixture.request, basePolicyDigest: 'b'.repeat(64) }, outcome: undefined })).toThrow();
  });
});
