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
const validSha256 = `sha256:${'a'.repeat(64)}`;

function buildProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    approvalRef,
    sourceKind: 'admin-plan',
    projectId: validScope.projectId,
    workspaceId: validScope.workspaceId,
    resourceRef: validScope.resourceRef,
    authorityClass: 'privileged-operation',
    subject: 'Restart test service',
    scopeDigest: validSha256,
    decision: 'approved',
    decisionVersion: validSha256,
    updatedAt: '2026-08-02T18:00:00.000Z',
    ...overrides,
  };
}

function buildProjectionUnknown(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...buildProjection(),
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
      decisionVersion: validSha256,
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

  it('accepts timezone-aware updatedAt timestamps from accepted producer payloads', async () => {
    const validUpdatedAt = [
      '2026-01-01T10:00:00+00:00',
      '2026-01-01T10:00:00.1+00:00',
      '2026-01-01T10:00:00.123456+00:00',
      '2026-01-01T10:00:00+0000',
      '2026-01-01T10:00:00-05:30',
    ];

    for (const updatedAt of validUpdatedAt) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjection({ updatedAt }),
      });

      await expect(provider.getStatus(approvalRef, validScope)).resolves.toMatchObject({ updatedAt });
    }
  });

  it('rejects invalid or unsupported updatedAt timestamps', async () => {
    const invalidUpdatedAt = [
      '2026-01-01T10:00:00',
      '2026-13-01T10:00:00+00:00',
      '2026-02-29T10:00:00+00:00',
      '2026-01-01T10:60:00+00:00',
      '2026-01-01T10:00:00+0:00',
      '2026-01-01T10:00:00.1234567+00:00',
    ];

    for (const updatedAt of invalidUpdatedAt) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjection({ updatedAt }),
      });

      await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload.');
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
    const unsupportedSource = buildProjectionUnknown({
      ...buildProjection(),
      sourceKind: 'admin-legacy',
    });

    const unsupportedAuthority = buildProjectionUnknown({
      ...buildProjection(),
      authorityClass: 'project',
    });

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

  it('rejects malformed source or authority values in projection', async () => {
    const malformedSourceProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => buildProjectionUnknown({
        sourceKind: 123,
      }),
    });

    const malformedAuthorityProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => buildProjectionUnknown({
        authorityClass: 456,
      }),
    });

    await expect(malformedSourceProvider.getStatus(approvalRef, validScope)).rejects.toThrow();
    await expect(malformedAuthorityProvider.getStatus(approvalRef, validScope)).rejects.toThrow();
  });

  it('rejects malformed sha256 digest and version fields', async () => {
    const invalidDigestProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => buildProjectionUnknown({
        scopeDigest: 'sha256:nothex',
      }),
    });

    const invalidVersionProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => buildProjectionUnknown({
        decisionVersion: 'sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      }),
    });

    await expect(invalidDigestProvider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload.');
    await expect(invalidVersionProvider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload.');
  });

  it('rejects malformed JSON, missing fields, extra fields, inherited fields, and non-enumerable or symbol extras', async () => {
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

    const inherited = Object.create(buildProjection());
    const inheritedProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => inherited,
    });
    await expect(inheritedProvider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload');

    const nonEnumerable = buildProjectionUnknown();
    Object.defineProperty(nonEnumerable, 'extraField', {
      value: 'hidden',
      enumerable: false,
      configurable: true,
    });
    const nonEnumerableProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => nonEnumerable,
    });
    await expect(nonEnumerableProvider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload');

    const symbolProjected: Record<string | symbol, unknown> = buildProjectionUnknown();
    symbolProjected[Symbol('x')] = 'secret';
    const symbolProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => symbolProjected,
    });
    await expect(symbolProvider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid approval status payload');
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

  it('enforces exact loopback API base before fetching', async () => {
    const fetchJson = vi.fn(async () => buildProjection());
    const provider = createOverseerApprovalStatusProvider({
      apiBase: 'https://example.invalid' as unknown as 'http://127.0.0.1:8766',
      readToken: () => token,
      fetchJson,
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('Overseer API base is not permitted.');
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens before fetch', async () => {
    const fetchJson = vi.fn(async () => buildProjection());
    const invalidTokens: unknown[] = [
      '',
      '   ',
      ' token',
      `token\n`,
      'x'.repeat(300),
      123,
    ];

    for (const badToken of invalidTokens) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => badToken as string,
        fetchJson,
      });

      await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid overseer token.');
      expect(fetchJson).not.toHaveBeenCalled();
    }
  });

  it('redacts provider error details from all failure categories', async () => {
    const redactedToken = 'top-secret-token';
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => redactedToken,
      fetchJson: async () => {
        throw new Error(`upstream failed using path /roadex/approval-status?approval_ref=${encodeURIComponent(approvalRef)} with token=${redactedToken}`);
      },
    });

    const result = await provider.getStatus(approvalRef, validScope).then(
      () => undefined,
      (error) => error,
    );
    expect((result as Error).message).not.toContain(redactedToken);
    expect((result as Error).message).not.toContain('/roadex/approval-status');
  });

  it('rejects invalid content-length headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: {
          'content-length': '-1',
        },
      }),
    );

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid content-length');

    fetchSpy.mockRestore();
  });

  it('rejects non-integral content-length headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: {
          'content-length': '12.7',
        },
      }),
    );

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('Invalid content-length');

    fetchSpy.mockRestore();
  });

  it('rejects oversized multibyte response bodies before parsing', async () => {
    const payload = buildProjection({
      subject: '你'.repeat(12000),
      updatedAt: '2026-01-01T10:00:00+00:00',
    });
    const responseText = JSON.stringify(payload);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseText, { status: 200 }));

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    await expect(provider.getStatus(approvalRef, validScope)).rejects.toThrow('response is oversized');

    fetchSpy.mockRestore();
  });

  it('aborts default fetch on timeout', async () => {
    let aborted = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('missing signal'));
          return;
        }
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('fetch aborted'));
        });
      });
    });

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    vi.useFakeTimers();
    const pending = provider.getStatus(approvalRef, validScope).then(() => undefined, (error) => error);
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(pending).resolves.toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    expect(aborted).toBe(true);
    vi.useRealTimers();

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

  it('reads token for each request', async () => {
    const tokens = ['token-rot-0', 'token-rot-1'];
    let tokenIndex = 0;

    const fetchTokenLog: string[] = [];
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => {
        const value = tokens[tokenIndex];
        tokenIndex += 1;
        return value;
      },
      fetchJson: async (_path, fetchedToken) => {
        fetchTokenLog.push(fetchedToken);
        return buildProjection();
      },
    });

    await provider.getStatus(approvalRef, validScope);
    await provider.getStatus(approvalRef, validScope);

    expect(fetchTokenLog).toEqual(tokens);
  });

  it('contains no approval mutation endpoints in source', () => {
    const source = readFileSync(new URL('../src/server/approvalStatusProvider.ts', import.meta.url), 'utf8');

    expect(source).toContain('/roadex/approval-status?approval_ref=');
    expect(source).not.toContain('/admin/policies');
    expect(source).not.toContain('/roadex/human-decisions');
    expect(source).not.toContain('/backup-provisioning/plans');
  });
});
