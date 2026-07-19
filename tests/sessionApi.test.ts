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
});
