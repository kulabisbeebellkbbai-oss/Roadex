import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fixturePath = resolve(process.cwd(), 'tests/fixtures/approval_source_contract_v1.json');
const canonicalFixturePath = resolve(
  process.cwd(),
  '../../..',
  'Overseer/.worktrees/reusable-approval-facility/tests/fixtures/approval_source_contract_v1.json',
);

const expectedStageTypes = {
  provider: 'string',
  approvalRef: 'string',
  projectId: 'string',
  workspaceId: 'string',
  resourceRef: 'string',
  authorityClass: 'string',
  scopeDigest: 'sha256',
};

const expectedStatusTypes = {
  ...expectedStageTypes,
  sourceKind: 'string',
  subject: 'string',
  decision: 'approval-decision',
  decisionVersion: 'sha256',
  updatedAt: 'rfc3339-date-time',
};

describe('approval source contract v1', () => {
  it('is an exact byte mirror of the Overseer canonical fixture', () => {
    expect(readFileSync(fixturePath)).toEqual(readFileSync(canonicalFixturePath));
  });

  it('fixes public locator/status field types and every safe conformance case', () => {
    const contract = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

    expect(contract.contractVersion).toBe('approval-source-contract/v1');
    expect(contract.schemas).toEqual({
      stageLocator: { additionalProperties: false, fields: expectedStageTypes },
      statusProjection: { additionalProperties: false, fields: expectedStatusTypes },
    });

    const stageLocator = contract.stageLocator as Record<string, string>;
    const statusProjection = contract.statusProjection as Record<string, string>;
    expect(Object.keys(stageLocator).sort()).toEqual(Object.keys(expectedStageTypes).sort());
    expect(stageLocator).not.toHaveProperty('decisionVersion');
    expect(statusProjection).toHaveProperty('decisionVersion');
    expect(statusProjection.decisionVersion).toMatch(/^sha256:[a-f0-9]{64}$/);

    const cases = contract.cases as Array<{ name: string }>;
    expect(cases.map(({ name }) => name).sort()).toEqual([
      'approved',
      'changed-replay',
      'exact-replay',
      'malformed-payload',
      'pending',
      'provider-failure',
      'rejected',
      'revision-requested',
      'scope-mismatch',
    ]);
  });
});
