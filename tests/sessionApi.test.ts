import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Roadex client CSRF contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('forwards the bootstrap CSRF header on descriptor observation', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-roadex-csrf': 'private-test-value',
          },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        observation: {
          id: 'observation',
          sessionId: 'session',
          projectId: 'project',
          inventoryBindingId: 'binding',
          vendorId: 0x10c4,
          productId: 0xea60,
          status: 'observed',
          verification: 'unverified',
          createdAt: new Date(0).toISOString(),
        },
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));

    const { loginAndBootstrap, submitDeviceDescriptorObservation } = await import('../src/client/sessionApi');
    await loginAndBootstrap();
    await submitDeviceDescriptorObservation(undefined, 'session', {
      inventoryBindingId: 'binding',
      vendorId: 0x10c4,
      productId: 0xea60,
    });

    expect(calls[1].path).toBe('/Roadex/api/sessions/session/device-bridge/observations');
    const headers = new Headers(calls[1].init?.headers);
    expect(headers.has('x-roadex-csrf')).toBe(true);
    expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it('creates a probe request and owner approval without starting an operation', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'private-test-value' },
        });
      }
      if (path.endsWith('/artifacts')) {
        return new Response(JSON.stringify({ artifacts: [{ id: 'artifact', sha256: 'a'.repeat(64) }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/requests')) {
        return new Response(JSON.stringify({ ok: true, request: { id: 'request' } }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, approval: { id: 'approval', status: 'pending' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const {
      createDeviceBridgeProbeApproval,
      listActiveDeviceArtifacts,
      loginAndBootstrap,
    } = await import('../src/client/sessionApi');
    await loginAndBootstrap();
    const artifacts = await listActiveDeviceArtifacts(undefined, 'session');
    await createDeviceBridgeProbeApproval(undefined, 'session', {
      workspaceId: 'project',
      artifactId: artifacts[0].id,
      artifactSha256: artifacts[0].sha256,
      inventoryBindingId: 'binding',
      operation: 'esp32.flash',
    });

    expect(calls.map((call) => call.path)).toEqual([
      '/api/bootstrap',
      '/Roadex/api/sessions/session/device-bridge/artifacts',
      '/Roadex/api/sessions/session/device-bridge/requests',
      '/Roadex/api/device-bridge/requests/request/approve',
    ]);
    for (const call of calls.slice(2)) {
      const headers = new Headers(call.init?.headers);
      expect(headers.has('x-roadex-csrf')).toBe(true);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    }
    expect(calls[3].init?.body).toBe('{}');
    expect(calls.some((call) => call.path.includes('start-probe'))).toBe(false);
  });

  it('keeps delivered firmware in memory only after SHA-256 verification', async () => {
    const bytes = new TextEncoder().encode('verified firmware bytes');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'x-roadex-artifact-sha256': sha256,
      },
    })));

    const { loadVerifiedFirmware } = await import('../src/client/sessionApi');
    const received = await loadVerifiedFirmware(undefined, {
      id: 'operation',
      approvalId: 'approval',
      sessionId: 'session',
      projectId: 'project',
      artifactId: 'artifact',
      artifactSha256: sha256,
      inventoryBindingId: 'binding',
      operation: 'esp32.flash',
      phase: 'confirmation',
      verifiedArtifactSha256: sha256,
      nextEventSequence: 1,
      phaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      reportingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(new Uint8Array(received)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith('/Roadex/api/device-bridge/operations/operation/artifact', expect.objectContaining({ cache: 'no-store' }));
  });

  it('uses exact CSRF-protected write authorization and terminal report routes', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'private-test-value' },
        });
      }
      const phase = path.endsWith('/report') ? 'completed' : 'destructive';
      return new Response(JSON.stringify({
        ok: true,
        operation: { id: 'operation', artifactSha256: 'a'.repeat(64), phase },
        ...(phase === 'destructive' ? { writeToken: 'w'.repeat(43) } : {}),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'private-test-value' },
      });
    }));
    const { authorizeVerifiedFirmwareWrite, loginAndBootstrap, reportVerifiedFirmwareWrite } = await import('../src/client/sessionApi');
    await loginAndBootstrap();
    const operation = {
      id: 'operation', artifactSha256: 'a'.repeat(64), phase: 'confirmation',
    } as Parameters<typeof authorizeVerifiedFirmwareWrite>[1];
    const authorized = await authorizeVerifiedFirmwareWrite(undefined, operation, 'aa:bb:cc:dd:ee:ff');
    await reportVerifiedFirmwareWrite(undefined, authorized.operation, authorized.writeToken, 'completed');

    expect(calls.map((call) => call.path)).toEqual([
      '/api/bootstrap',
      '/Roadex/api/device-bridge/operations/operation/authorize-write',
      '/Roadex/api/device-bridge/operations/operation/report',
    ]);
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init?.headers);
      expect(headers.has('x-roadex-csrf')).toBe(true);
      expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    }
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ artifactSha256: 'a'.repeat(64), deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ artifactSha256: 'a'.repeat(64), outcome: 'completed', writeToken: 'w'.repeat(43) });
  });

  it('retries a terminal write report with the same idempotency key', async () => {
    const requestIds: string[] = [];
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      requestIds.push(new Headers(init?.headers).get('x-roadex-request-id') ?? '');
      if (attempts < 3) throw new Error('temporary network failure');
      return new Response(JSON.stringify({
        ok: true,
        operation: { id: 'operation', artifactSha256: 'a'.repeat(64), phase: 'completed' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const { reportVerifiedFirmwareWrite } = await import('../src/client/sessionApi');
    const operation = await reportVerifiedFirmwareWrite(
      undefined,
      { id: 'operation', artifactSha256: 'a'.repeat(64), phase: 'destructive' } as Parameters<typeof reportVerifiedFirmwareWrite>[1],
      'w'.repeat(43),
      'completed',
    );
    expect(operation.phase).toBe('completed');
    expect(new Set(requestIds).size).toBe(1);
  });

  it('runs only the approved probe endpoints with JSON and CSRF', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'private-test-value' },
        });
      }
      const operation = {
        id: 'operation',
        artifactSha256: 'a'.repeat(64),
        phase: path.endsWith('/confirm') ? 'confirmation' : path.endsWith('/probe') && !path.endsWith('/start-probe') ? 'verified' : 'probe',
      };
      return new Response(JSON.stringify({ ok: true, operation }), {
        status: path.endsWith('/start-probe') ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const { confirmVerifiedDeviceProbe, loginAndBootstrap, runDeviceBridgeProbe } = await import('../src/client/sessionApi');
    await loginAndBootstrap();
    const operation = await runDeviceBridgeProbe(undefined, {
      id: 'approval',
      requestId: 'request',
      sessionId: 'session',
      projectId: 'project',
      artifactId: 'artifact',
      artifactSha256: 'a'.repeat(64),
      inventoryBindingId: 'binding',
      operation: 'esp32.flash',
      status: 'pending',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    }, '00:11:22:33:44:55');
    await confirmVerifiedDeviceProbe(undefined, operation.id);

    expect(calls.map((call) => call.path)).toEqual([
      '/api/bootstrap',
      '/Roadex/api/device-bridge/approvals/approval/start-probe',
      '/Roadex/api/device-bridge/operations/operation/probe',
      '/Roadex/api/device-bridge/operations/operation/confirm',
    ]);
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.has('x-roadex-csrf')).toBe(true);
      expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    }
    expect(calls.some((call) => /authorize-write|flash|erase|firmware/.test(call.path))).toBe(false);
  });
});
