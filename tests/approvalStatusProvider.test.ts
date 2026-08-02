import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createOverseerApprovalStatusProvider,
  type ApprovalScope,
} from '../src/server/approvalStatusProvider';

type DecisionValue = 'pending' | 'approved' | 'changes-requested' | 'rejected' | 'expired' | 'revoked';

type Projection = {
  approvalRef: string;
  sourceKind: 'admin-plan' | 'roadex-human-decision';
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  authorityClass: 'privileged-operation' | 'project-workflow';
  subject: string;
  scopeDigest: string;
  decision: DecisionValue;
  decisionVersion: string;
  updatedAt: string;
};

const validScope: ApprovalScope = {
  projectId: 'project.test',
  workspaceId: 'workspace.test',
  resourceRef: 'service.test',
};

const approvalRef = 'admin.roadex.test';
const token = 'secret-token-123';

function buildProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    approvalRef,
    sourceKind: 'admin-plan',
    projectId: validScope.projectId,
    workspaceId: validScope.workspaceId,
    resourceRef: validScope.resourceRef,
    authorityClass: 'privileged-operation',
    subject: 'Restart test service',
    scopeDigest: 'sha256:scope',
    decision: 'approved',
    decisionVersion: 'sha256:decision',
    updatedAt: '2026-08-02T18:00:00.000Z',
    ...overrides,
  };
}

describe('createOverseerApprovalStatusProvider', () => {
  it('reads only the exact scoped projection', async () => {
    const fetchJson = vi.fn(async () => buildProjection());

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson,
    });

    const status = await provider.getStatus(approvalRef, validScope);

    expect(fetchJson).toHaveBeenCalledWith('/roadex/approval-status?approval_ref=admin.roadex.test', token);
    expect(status).toMatchObject({
      provider: 'overseer',
      approvalRef,
      authorityClass: 'privileged-operation',
      decision: 'approved',
      decisionVersion: 'sha256:decision',
      projectId: validScope.projectId,
      workspaceId: validScope.workspaceId,
      resourceRef: validScope.resourceRef,
      subject: 'Restart test service',
      updatedAt: '2026-08-02T18:00:00.000Z',
    });
  });

  it('returns every exact approval decision', async () => {
    const decisions: DecisionValue[] = ['pending', 'approved', 'changes-requested', 'rejected', 'expired', 'revoked'];

    for (const decision of decisions) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjection({ decision }),
      });

      await expect(provider.getStatus(approvalRef, validScope)).resolves.toMatchObject({ decision });
    }
  });

  it('percent-encodes approval reference and uses the exact query path', async () => {
    const encodedApprovalRef = 'admin.roadex.test/abc?x=1';
    const fetchJson = vi.fn(async () => buildProjection({ approvalRef: encodedApprovalRef }));
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson,
    });

    await provider.getStatus(encodedApprovalRef, validScope);

    expect(fetchJson).toHaveBeenCalledWith(
      '/roadex/approval-status?approval_ref=admin.roadex.test%2Fabc%3Fx%3D1',
      token,
    );
  });

  it('rejects unsupported scope fields', async () => {
    const mismatches: ApprovalScope[] = [
      { ...validScope, projectId: 'project-other' },
      { ...validScope, workspaceId: 'workspace-other' },
      { ...validScope, resourceRef: 'resource-other' },
    ];

    for (const scoped of mismatches) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjection(),
      });

      await expect(provider.getStatus(approvalRef, scoped)).rejects.toThrow('does not match expected scope');
    }
  });

  it('rejects approval reference mismatch', async () => {
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => buildProjection({ approvalRef: 'admin.other.test' }),
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('does not match expected scope');
  });

  it('rejects unsupported source kind and authority', async () => {
    const unsupportedSource = {
      ...buildProjection(),
      sourceKind: 'admin-legacy',
    } as Projection & { sourceKind: string };

    const unsupportedAuthority = {
      ...buildProjection(),
      authorityClass: 'project',
    } as Projection & { authorityClass: string };

    const unsupportedSourceProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => unsupportedSource,
    });

    const unsupportedAuthorityProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => unsupportedAuthority,
    });

    await expect(unsupportedSourceProvider.getStatus(approvalRef, validScope)).rejects.toThrow();
    await expect(unsupportedAuthorityProvider.getStatus(approvalRef, validScope)).rejects.toThrow();
  });

  it('rejects malformed JSON, missing fields, and extra fields', async () => {
    const malformed = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => 'not-json',
    });
    await expect(malformed.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload');

    const missing = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => ({ approvalRef }),
    });
    await expect(missing.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload');

    const extra = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => ({
        ...buildProjection(),
        extraField: 'should-be-rejected',
      }),
    });
    await expect(extra.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload');
  });

  it('treats token-read, timeout, and fetch failures as closed scope', async () => {
    const failRead = createOverseerApprovalStatusProvider({
      readToken: () => {
        throw new Error(`unable to read token ${token}`);
      },
    });

    await expect(failRead.getStatus(approvalRef, validScope)).rejects.toThrow('Failed to read overseer token');

    const timedOut = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => new Promise<Projection>(() => {}),
    });

    vi.useFakeTimers();
    const pending = timedOut.getStatus(approvalRef, validScope).then(
      () => {
        throw new Error('should not resolve');
      },
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(5100);
    await expect(pending).resolves.toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    vi.useRealTimers();
  });

  it('rejects oversized response bodies', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x'.repeat(40_000), { status: 200 }),
    );

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('response is oversized');

    fetchSpy.mockRestore();
  });

  it('uses fixed base path and request shape', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(buildProjection()), { status: 200 }),
    );

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    expect(Object.keys(provider)).toEqual(['getStatus']);

    await provider.getStatus(approvalRef, validScope);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers?: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:8766/roadex/approval-status?approval_ref=admin.roadex.test');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });

    fetchSpy.mockRestore();
  });

  it('returns redacted errors when token is echoed by provider errors', async () => {
    const redactedToken = 'top-secret-token';
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => redactedToken,
      fetchJson: async () => {
        throw new Error(`upstream failed using token ${redactedToken}`);
      },
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toMatchObject({
      message: expect.not.stringContaining(redactedToken),
    });
  });

  it('contains no approval mutation endpoints in source', () => {
    const source = readFileSync(new URL('../src/server/approvalStatusProvider.ts', import.meta.url), 'utf8');

    expect(source).toContain('/roadex/approval-status?approval_ref=');
    expect(source).not.toContain('/admin/policies');
    expect(source).not.toContain('/roadex/human-decisions');
    expect(source).not.toContain('/backup-provisioning/plans');
  });
});
