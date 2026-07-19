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
      expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    }
    expect(calls.some((call) => call.path.includes('start-probe'))).toBe(false);
  });
});
