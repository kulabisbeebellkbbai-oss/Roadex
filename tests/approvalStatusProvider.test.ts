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
    updatedAt: '2026-08-02T18:00:00+00:00',
    ...overrides,
  };
}

function buildProjectionUnknown(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...buildProjection(),
    ...overrides,
  };
}

const requestTimeoutCode = 'approval_status:request_timeout';
const invalidPayloadCode = 'approval_status:invalid_payload';
const tokenReadFailedCode = 'approval_status:token_read_failed';
const tokenInvalidCode = 'approval_status:token_invalid';
const apiBaseDeniedCode = 'approval_status:api_base_not_permitted';
const requestFailedCode = 'approval_status:request_failed';
const invalidContentLengthCode = 'approval_status:invalid_content_length';
const responseOversizedCode = 'approval_status:response_oversized';
const scopeMismatchCode = 'approval_status:scope_mismatch';

const maxTimeoutMs = 5_100;

async function expectFailureCode<T>(promise: Promise<T>, code: string): Promise<string> {
  const error = await promise.then(
    () => undefined as unknown,
    (result) => result,
  );

  const message = error instanceof Error ? error.message : String(error);
  expect(message).toBe(code);
  return message;
}

describe('createOverseerApprovalStatusProvider', () => {
  it('reads only the exact scoped projection', async () => {
    const fetchJson = vi.fn(async () => buildProjection());

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson,
    });

    const status = await provider.getStatus(approvalRef, validScope);

    expect(fetchJson).toHaveBeenCalledWith('/roadex/approval-status?approval_ref=admin.roadex.test', token, expect.any(AbortSignal));
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
      updatedAt: '2026-08-02T18:00:00+00:00',
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

  it('accepts strict timezone-aware producer ISO-8601 timestamps', async () => {
    const validUpdatedAt = [
      '2026-01-01T10:00:00+00:00',
      '2026-01-01T10:00:00.1+00:00',
      '2026-01-01T10:00:00.123456+00:00',
      '2026-01-01T10:00:00-05:30',
      '2026-01-01T10:00:00.999999+09:00',
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
      '2026-01-01T10:00:00+24:00',
      '2026-01-01T10:00:00+00:60',
      '2026-01-01T10:00:00+0:00',
      '2026-01-01T10:00:00-1:30',
      '2026-01-01T10:00:00.1234567+00:00',
      '2026-01-01T10:00:00+0000',
      '2026-01-01T10:00:00+14:30',
      '2026-01-01T10:00:00-14:01',
    ];

    for (const updatedAt of invalidUpdatedAt) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjection({ updatedAt }),
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), invalidPayloadCode);
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
      expect.any(AbortSignal),
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

      await expectFailureCode(provider.getStatus(approvalRef, scoped), scopeMismatchCode);
    }
  });

  it('rejects approval reference mismatch', async () => {
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => buildProjection({ approvalRef: 'admin.other.test' }),
    });

    await expectFailureCode(provider.getStatus(approvalRef, validScope), scopeMismatchCode);
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

    await expectFailureCode(unsupportedSourceProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
    await expectFailureCode(unsupportedAuthorityProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
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

    await expectFailureCode(malformedSourceProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
    await expectFailureCode(malformedAuthorityProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
  });

  it('rejects malformed sha256 digest and version fields', async () => {
    const invalidDigestValues = [
      'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'z'.repeat(64)}`,
    ];

    const invalidVersionValues = [
      'sha256:nothex',
      `sha256:${'a'.repeat(64).toUpperCase()}`,
      `sha256:${'a'.repeat(65)}`,
    ];

    for (const scopeDigest of invalidDigestValues) {
      const invalidDigestProvider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjectionUnknown({ scopeDigest }),
      });
      await expectFailureCode(invalidDigestProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
    }

    for (const decisionVersion of invalidVersionValues) {
      const invalidVersionProvider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjectionUnknown({ decisionVersion }),
      });
      await expectFailureCode(invalidVersionProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
    }
  });

  it('validates response shape exactly with own keys only', async () => {
    const malformed = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => 'not-json',
    });
    await expectFailureCode(malformed.getStatus(approvalRef, validScope), invalidPayloadCode);

    const missing = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => ({ approvalRef }),
    });
    await expectFailureCode(missing.getStatus(approvalRef, validScope), invalidPayloadCode);

    const extra = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => ({
        ...buildProjection(),
        extraField: 'should-be-rejected',
      }),
    });
    await expectFailureCode(extra.getStatus(approvalRef, validScope), invalidPayloadCode);

    const inherited = Object.create(buildProjection());
    const inheritedProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => inherited,
    });
    await expectFailureCode(inheritedProvider.getStatus(approvalRef, validScope), invalidPayloadCode);

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
    await expectFailureCode(nonEnumerableProvider.getStatus(approvalRef, validScope), invalidPayloadCode);

    const symbolProjected: Record<string | symbol, unknown> = buildProjectionUnknown();
    symbolProjected[Symbol('x')] = 'secret';
    const symbolProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => symbolProjected,
    });
    await expectFailureCode(symbolProvider.getStatus(approvalRef, validScope), invalidPayloadCode);

    let accessorAccessCount = 0;
    const accessorProjected = buildProjectionUnknown();
    Object.defineProperty(accessorProjected, 'decision', {
      get() {
        accessorAccessCount += 1;
        return 'approved';
      },
      enumerable: true,
    });
    const accessorProvider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => accessorProjected,
    });
    await expectFailureCode(accessorProvider.getStatus(approvalRef, validScope), invalidPayloadCode);
    expect(accessorAccessCount).toBe(0);
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

  it('uses a validated snapshot and does not read properties from hostile proxy projections', async () => {
    const source = buildProjection();
    const requiredProjectionFields = [
      'approvalRef',
      'sourceKind',
      'projectId',
      'workspaceId',
      'resourceRef',
      'authorityClass',
      'subject',
      'scopeDigest',
      'decision',
      'decisionVersion',
      'updatedAt',
    ] as const;
    const requiredProjectionFieldSet = new Set(requiredProjectionFields as readonly string[]);
    const propertyGetLog: Array<string | symbol> = [];
    const descriptorLog = new Map<string, PropertyDescriptor>();
    const descriptorReadCount = new Map<string, number>();

    const proxyProjection = new Proxy(source, {
      get(_target, property) {
        propertyGetLog.push(property);
        if (property === 'then') {
          return undefined;
        }
        if (typeof property === 'string' && requiredProjectionFieldSet.has(property)) {
          throw new Error('proxy-get-called');
        }
        return undefined;
      },
      ownKeys(_target) {
        return Reflect.ownKeys(_target);
      },
      getOwnPropertyDescriptor(_target, property) {
        if (typeof property === 'string' && requiredProjectionFieldSet.has(property)) {
          const call = (descriptorReadCount.get(property) ?? 0) + 1;
          descriptorReadCount.set(property, call);
          const descriptor = Reflect.getOwnPropertyDescriptor(_target as Record<string, unknown>, property);
          if (descriptor !== undefined) {
            descriptorLog.set(property, descriptor);
          }
          if (call > 1) {
            return {
              value: undefined,
              enumerable: true,
              configurable: false,
              writable: false,
            } as PropertyDescriptor;
          }
          return descriptor;
        }
        return Reflect.getOwnPropertyDescriptor(_target as Record<string, unknown>, property);
      },
    });

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => proxyProjection,
    });

    const status = await provider.getStatus(approvalRef, validScope);
    expect(status).toMatchObject({
      approvalRef,
      authorityClass: 'privileged-operation',
      projectId: validScope.projectId,
    });

    expect(propertyGetLog.includes('then')).toBe(true);
    for (const field of requiredProjectionFields) {
      expect(propertyGetLog.includes(field)).toBe(false);
    }

    expect(propertyGetLog.every((property) => property === 'then' || typeof property === 'symbol')).toBe(true);

    for (const field of requiredProjectionFields) {
      const descriptor = descriptorLog.get(field);
      expect(descriptor).toEqual(Object.getOwnPropertyDescriptor(source, field));
      expect(descriptor?.enumerable).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(descriptor, 'value')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(descriptor, 'get')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(descriptor, 'set')).toBe(false);
      expect(descriptorReadCount.get(field)).toBe(1);
    }
  });

  it('rejects malformed tokens before any request', async () => {
    const fetchJson = vi.fn(async () => buildProjection());
    const invalidTokens: unknown[] = [
      '',
      '   ',
      ' token',
      `token\n`,
      'x'.repeat(300),
      123,
      'Bearer abc',
    ];

    for (const badToken of invalidTokens) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => badToken as string,
        fetchJson,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), tokenInvalidCode);
      expect(fetchJson).not.toHaveBeenCalled();
      fetchJson.mockClear();
    }
  });

  it('rejects when token reader fails and does not leak related error text', async () => {
    const sensitive = 'token-reader-secret-123';
    const provider = createOverseerApprovalStatusProvider({
      readToken: () => {
        throw new Error(`unable to read token ${sensitive}`);
      },
      fetchJson: async () => buildProjection(),
    });

    const message = await expectFailureCode(provider.getStatus(approvalRef, validScope), tokenReadFailedCode);
    expect(message).not.toContain(sensitive);
  });

  it('hard-fails invalid content-length headers', async () => {
    const invalidHeaders = ['-1', '12.7', 'not-a-number'];
    for (const header of invalidHeaders) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', {
        status: 200,
        headers: {
          'content-length': header,
        },
      }));
      try {
        const provider = createOverseerApprovalStatusProvider({
          readToken: () => token,
        });

        await expectFailureCode(provider.getStatus(approvalRef, validScope), invalidContentLengthCode);
      } finally {
        fetchSpy.mockRestore();
      }
    }
  });

  it('requires declared content-length to match the exact response byte count', async () => {
    const responsePayload = buildProjection({
      updatedAt: '2026-01-01T10:00:00+00:00',
    });
    const body = JSON.stringify(responsePayload);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'content-length': '1',
      },
    }));
    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), invalidContentLengthCode);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('requires exact content-length for both shorter and longer payloads', async () => {
    const responsePayload = buildProjection({
      updatedAt: '2026-01-01T10:00:00+00:00',
    });
    const body = JSON.stringify(responsePayload);
    const bodyLength = new TextEncoder().encode(body).length;

    const tooShortSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'content-length': String(Math.max(0, bodyLength - 1)),
      },
    }));
    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), invalidContentLengthCode);
    } finally {
      tooShortSpy.mockRestore();
    }

    const tooLongSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'content-length': String(bodyLength + 1),
      },
    }));
    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), invalidContentLengthCode);
    } finally {
      tooLongSpy.mockRestore();
    }
  });

  it('rejects oversized response headers and oversized multibyte payloads before parsing', async () => {
    const oversizedHeaderResponse = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', {
      status: 200,
      headers: {
        'content-length': String(33_000),
      },
    }));

    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), responseOversizedCode);
    } finally {
      oversizedHeaderResponse.mockRestore();
    }

    const payload = buildProjection({
      subject: '你'.repeat(12000),
      updatedAt: '2026-01-01T10:00:00+00:00',
    });
    const responseText = JSON.stringify(payload);

    const multibyteResponse = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseText, { status: 200 }));
    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), responseOversizedCode);
    } finally {
      multibyteResponse.mockRestore();
    }
  });

  it('forces approval_status:response_oversized when oversized body cancel rejects', async () => {
    const oversizeBody = new TextEncoder().encode('x'.repeat(33_000));
    let cancelCalled = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(oversizeBody);
      },
      cancel() {
        cancelCalled += 1;
        return Promise.reject(new Error('reader-cancel-rejection'));
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));

    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), responseOversizedCode);
      expect(cancelCalled).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('maps malformed UTF-8 payload bytes to invalid-payload', async () => {
    const malformedBody = new Uint8Array([0xff]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(malformedBody, {
      status: 200,
    }));

    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });
      await expectFailureCode(provider.getStatus(approvalRef, validScope), invalidPayloadCode);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('times out default fetch and proves abort signal activation', { timeout: maxTimeoutMs + 1_000 }, async () => {
    let abortReceived = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined) {
          reject(new Error('missing signal'));
          return;
        }
        signal.addEventListener('abort', () => {
          abortReceived = true;
          reject(new Error('ignored-secret path=/roadex/approval-status?approval_ref=admin.roadex.test token=do-not-leak'));
        });
      });
    });

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    try {
      const timeoutResult = provider.getStatus(approvalRef, validScope).then(() => undefined, (result) => {
        const message = result instanceof Error ? result.message : String(result);
        return message;
      });

      const error = await timeoutResult;
      expect(error).toBe(requestTimeoutCode);
      expect(abortReceived).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('times out injected fetchJson using the same abort protocol', { timeout: maxTimeoutMs + 1_000 }, async () => {
    const fetchJson = vi.fn((_path, _token, signal) => {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('injected timeout test payload'));
        });
      });
    });

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson,
    });

    try {
      const timeoutResult = provider.getStatus(approvalRef, validScope).then(() => undefined, (result) => result as Error);
      const error = await timeoutResult;
      expect(error.message).toBe(requestTimeoutCode);
      expect(fetchJson).toHaveBeenCalledWith(
        '/roadex/approval-status?approval_ref=admin.roadex.test',
        token,
        expect.any(AbortSignal),
      );
    } finally {
      // no cleanup required
    }
  });

  it('bounds injected fetchJson by timeout and forwards abort signal', { timeout: maxTimeoutMs + 1_000 }, async () => {
    let aborted = false;
    const fetchJson = vi.fn((_path, _token, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('ignored secret: injector-secret-please-hide'));
        });
      });
    });

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson,
    });

    const error = await provider.getStatus(approvalRef, validScope).then(() => undefined, (result) => result as Error);

    expect(error.message).toBe(requestTimeoutCode);
    expect(aborted).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith(
      '/roadex/approval-status?approval_ref=admin.roadex.test',
      token,
      expect.any(AbortSignal),
    );
  });

  it('rejects when API base is not exactly the fixed loopback and before token read', async () => {
    const readToken = vi.fn(() => {
      throw new Error('this must not run');
    });

    expect(() =>
      createOverseerApprovalStatusProvider({
        apiBase: 'https://example.invalid' as unknown as 'http://127.0.0.1:8766',
        readToken,
      }),
    ).toThrow(apiBaseDeniedCode);

    expect(readToken).not.toHaveBeenCalled();

    expect(() =>
      createOverseerApprovalStatusProvider({
        apiBase: 'http://127.0.0.1:8767' as unknown as 'http://127.0.0.1:8766',
        readToken: () => token,
      }),
    ).toThrow(apiBaseDeniedCode);
  });

  it('uses the fixed base path and request shape', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(buildProjection()), { status: 200 }),
    );

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
    });

    expect(Object.keys(provider)).toEqual(['getStatus']);

    try {
      await provider.getStatus(approvalRef, validScope);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers?: Record<string, string> }];
      expect(url).toBe('http://127.0.0.1:8766/roadex/approval-status?approval_ref=admin.roadex.test');
      expect(init.method).toBe('GET');
      expect(init.cache).toBe('no-store');
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails closed when default fetch encounters a redirect boundary', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('redirect to unknown host blocked'));

    try {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
      });

      await expectFailureCode(provider.getStatus(approvalRef, validScope), requestFailedCode);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('redacts arbitrary upstream error text across token/fetch/parser boundaries', async () => {
    const fakeSecrets = ['top-secret-token', 'path=/roadex/approval-status?approval_ref=admin.roadex.test', 'Authorization: Bearer nope'];

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => {
        throw new Error(`upstream failed with ${fakeSecrets.join(' ')}`);
      },
    });

    const message = await expectFailureCode(provider.getStatus(approvalRef, validScope), requestFailedCode);
    for (const secret of fakeSecrets) {
      expect(message).not.toContain(secret);
    }
  });

  it('does not trust mutated constructor-sourced provider errors from injected callbacks', async () => {
    let capturedProviderError: unknown;
    try {
      createOverseerApprovalStatusProvider({
        apiBase: 'https://example.invalid' as unknown as 'http://127.0.0.1:8766',
        readToken: () => token,
      });
    } catch (error) {
      capturedProviderError = error;
    }

    expect(capturedProviderError).toBeInstanceOf(Error);

    const replayedError = capturedProviderError as { message: string; code?: string };
    replayedError.message = scopeMismatchCode;
    replayedError.code = requestTimeoutCode;

    const provider = createOverseerApprovalStatusProvider({
      readToken: () => token,
      fetchJson: async () => {
        throw replayedError;
      },
    });

    const message = await expectFailureCode(provider.getStatus(approvalRef, validScope), requestFailedCode);
    expect(message).not.toBe(scopeMismatchCode);
    expect(message).not.toBe(requestTimeoutCode);
    expect(message).toBe(requestFailedCode);
  });

  it('does not trust genuine provider failures replayed across requests or providers', async () => {
    const originatingProviders = [
      createOverseerApprovalStatusProvider({
        readToken: () => '',
        fetchJson: async () => buildProjection(),
      }),
      createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => ({ ...buildProjection(), unexpected: 'field' }),
      }),
      createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => buildProjection({ projectId: 'project-neighbor' }),
      }),
    ];

    for (const originatingProvider of originatingProviders) {
      const captured = await originatingProvider.getStatus(approvalRef, validScope)
        .then(() => undefined, (error) => error as Error & { code?: string });
      expect(captured).toBeInstanceOf(Error);

      captured.message = requestTimeoutCode;
      captured.code = scopeMismatchCode;

      const receivingProvider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => {
          throw captured;
        },
      });

      await expectFailureCode(receivingProvider.getStatus(approvalRef, validScope), requestFailedCode);
    }
  });

  it('normalizes injected stable public error codes to request_failed', async () => {
    const injectedCodes = [
      requestTimeoutCode,
      responseOversizedCode,
      invalidContentLengthCode,
      scopeMismatchCode,
      'approval_status:token_read_failed',
      'approval_status:invalid_payload',
    ];

    for (const injectedCode of injectedCodes) {
      const provider = createOverseerApprovalStatusProvider({
        readToken: () => token,
        fetchJson: async () => {
          throw new Error(injectedCode);
        },
      });

      const message = await expectFailureCode(provider.getStatus(approvalRef, validScope), requestFailedCode);
      expect(message).not.toBe(injectedCode);
    }
  });

  it('contains no approval mutation endpoints in source', () => {
    const source = readFileSync(new URL('../src/server/approvalStatusProvider.ts', import.meta.url), 'utf8');

    expect(source).toContain('/roadex/approval-status?approval_ref=');
    expect(source).not.toContain('/admin/policies');
    expect(source).not.toContain('/roadex/human-decisions');
    expect(source).not.toContain('/backup-provisioning/plans');
  });
});
