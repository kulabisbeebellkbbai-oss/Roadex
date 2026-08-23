import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindingDigest, type ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';

const projectRoot = '/srv/projects/arcade';

function currentBinding(overrides: Partial<ProjectHumanThreadBinding> = {}): ProjectHumanThreadBinding {
  const value = {
    schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
    bindingId: 'project-human-thread:arcade:1',
    projectId: 'arcade',
    root: { canonicalPath: projectRoot, dev: '1', ino: '2' },
    purpose: 'human-interaction' as const,
    conversationId: '11111111-1111-1111-1111-111111111111',
    generation: 1,
    status: 'replacement-pending' as const,
    predecessorGeneration: null,
    creationMode: 'created' as const,
    provenanceDigest: 'a'.repeat(64),
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:00:00.000Z',
    retiredAt: null,
    ...overrides,
  };
  return { ...value, recordDigest: bindingDigest(value) };
}

describe('Roadex client CSRF contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses only the project-scoped human thread lifecycle routes', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      const payload = path.endsWith('/human-thread')
        ? { ok: true, current: currentBinding(), candidates: [], replacement: { expectedGeneration: 1, reason: 'Resume safely', createPhase: 'reconcile-required' } }
        : path.endsWith('/history')
          ? { ok: true, history: [] }
          : { ok: true, result: { outcome: 'current' } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'private-test-value' },
      });
    }));
    const { getProjectHumanThread, getProjectHumanThreadHistory, mutateProjectHumanThread } = await import('../src/client/sessionApi');
    const thread = await getProjectHumanThread(undefined, 'arcade', projectRoot);
    expect(thread.replacement).toEqual({ expectedGeneration: 1, reason: 'Resume safely', createPhase: 'reconcile-required' });
    await getProjectHumanThreadHistory(undefined, 'arcade');
    await mutateProjectHumanThread(undefined, 'arcade', 'recover', 'recover-key-0000001', { expectedGeneration: 1 });
    expect(calls.map((call) => call.path)).toEqual([
      '/Roadex/api/projects/arcade/human-thread',
      '/Roadex/api/projects/arcade/human-thread/history',
      '/Roadex/api/projects/arcade/human-thread/recover',
    ]);
    const headers = new Headers(calls[2].init?.headers);
    expect(headers.get('idempotency-key')).toBe('recover-key-0000001');
    expect(headers.get('x-roadex-csrf')).toBe('private-test-value');
    expect(calls.some((call) => /approve|execute/.test(call.path))).toBe(false);
  });

  it('rejects a project human thread response that omits candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects malformed project human thread candidates before installing UI state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      candidates: [{ conversationId: 'not-a-complete-candidate' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects a malformed current project human thread binding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      current: { status: 'active' },
      candidates: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects a malformed replacement intent before exposing resume controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      candidates: [],
      replacement: { expectedGeneration: 1, reason: 'Resume safely', createPhase: 'unknown' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects a shaped binding for a different project and root', async () => {
    const other = currentBinding({
      bindingId: 'project-human-thread:other:1',
      projectId: 'other',
      root: { canonicalPath: '/srv/projects/other', dev: '1', ino: '2' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      current: other,
      candidates: [],
      replacement: { expectedGeneration: 1, reason: 'Resume safely', createPhase: 'reconcile-required' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects a binding whose record digest does not match its contents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      current: { ...currentBinding(), recordDigest: 'b'.repeat(64) },
      candidates: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects a retired binding presented as the current project thread', async () => {
    const retired = currentBinding({
      status: 'retired',
      retiredAt: '2026-08-22T13:00:00.000Z',
      updatedAt: '2026-08-22T13:00:00.000Z',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      current: retired,
      candidates: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects replacement state without a matching pending binding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      candidates: [],
      replacement: { expectedGeneration: 1, reason: 'Resume safely', createPhase: 'reconcile-required' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { getProjectHumanThread } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThread(undefined, 'arcade', projectRoot)).rejects.toThrow(
      'Project human thread response is invalid.',
    );
  });

  it('rejects a project human thread history response that omits history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { getProjectHumanThreadHistory } = await import('../src/client/sessionApi');

    await expect(getProjectHumanThreadHistory(undefined, 'arcade')).rejects.toThrow(
      'Project human thread history response is invalid.',
    );
  });

  it('creates and retrieves publication requests without exposing an activation call', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      return new Response(JSON.stringify({
        ok: true,
        request: {
          id: 'app-publication-1',
          contractVersion: 'roadex.app-publication.v1',
          spec,
          status: 'submitted',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          gates: { gatewayReview: 'pending', idsReview: 'pending', activationApproval: 'pending' },
          gateway: {},
        },
      }), { status: path.endsWith('/requests') ? 201 : 200, headers: { 'content-type': 'application/json' } });
    }));
    const spec = {
      contractVersion: 'roadex.app-publication.v1',
      project: { projectId: 'donuthole', projectName: 'DonutHole' },
      workspace: { workspaceId: 'donuthole' },
      app: { name: 'DonutHole' },
      publication: {
        routePrefix: '/Roadex/DonutHole',
        backendUrl: 'http://127.0.0.1:8798',
        allowedMethods: ['GET'],
        healthPath: '/health',
        routeSelection: 'longest-prefix',
        preserveFullPath: true,
        pathNeeds: { assets: [], apis: [] },
      },
      rollback: { mode: 'disable-route', healthPath: '/health' },
    } as const;
    const { createAppPublicationRequest, getAppPublicationRequest } = await import('../src/client/sessionApi');
    const created = await createAppPublicationRequest(undefined, spec, 'request-key-00000001');
    await getAppPublicationRequest(undefined, created.id);

    expect(calls.map((call) => call.path)).toEqual([
      '/Roadex/api/app-publication/requests',
      '/Roadex/api/app-publication/requests/app-publication-1',
    ]);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('idempotency-key')).toBe('request-key-00000001');
    expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(calls.some((call) => /activate|approve|deploy/.test(call.path))).toBe(false);
  });

  it('uses exact owner project proposal, challenge, confirmation, and revoke routes', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      const proposal = {
        id: 'project-proposal-1',
        projectName: 'Example',
        visibility: 'private',
        status: path.endsWith('/confirm') ? 'consumed' : path.endsWith('/revoke') ? 'revoked' : 'pending',
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(60_000).toISOString(),
      };
      const payload = path.endsWith('/challenge')
        ? { ok: true, challenge: { proposalId: proposal.id, challenge: 'c'.repeat(43), expiresAt: proposal.expiresAt } }
        : { ok: true, proposal };
      return new Response(JSON.stringify(payload), {
        status: path.endsWith('/proposals') ? 201 : 200,
        headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'private-test-value' },
      });
    }));

    const {
      confirmProjectProposal,
      createProjectProposal,
      requestProjectConfirmation,
      revokeProjectProposal,
    } = await import('../src/client/sessionApi');
    const proposal = await createProjectProposal(undefined, {
      sessionId: 'session-1',
      projectName: 'Example',
      visibility: 'private',
      teamId: 'team-1',
      idempotencyKey: 'request-key-ABCDEFGHIJKLMNOP',
      summary: {
        outcome: 'Create the application.',
        primaryUsers: 'Operators',
        majorComponents: ['UI'],
        risks: ['Authorization'],
        immediateNextSteps: ['Bootstrap'],
      },
    });
    const challenge = await requestProjectConfirmation(undefined, proposal.id);
    await confirmProjectProposal(undefined, proposal.id, {
      challenge: challenge.challenge,
      idempotencyKey: 'confirm-key-ABCDEFGHIJKLMNOP',
    });
    await revokeProjectProposal(undefined, proposal.id);

    expect(calls.map((call) => call.path)).toEqual([
      '/Roadex/api/project-creation/proposals',
      '/Roadex/api/project-creation/proposals/project-proposal-1/challenge',
      '/Roadex/api/project-creation/proposals/project-proposal-1/confirm',
      '/Roadex/api/project-creation/proposals/project-proposal-1/revoke',
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-roadex-request-id')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    }
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
    const authorizationBody = JSON.parse(String(calls[1].init?.body));
    expect(authorizationBody).toMatchObject({ artifactSha256: 'a'.repeat(64), deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(authorizationBody.writeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ artifactSha256: 'a'.repeat(64), outcome: 'completed', writeToken: authorizationBody.writeToken });
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

  it('preserves approval-wait projection fields from bootstrap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({
          user: { id: 'owner', displayName: 'Owner', authMode: 'mock', roles: ['user', 'admin', 'security-reviewer'] },
          workspaces: [{ id: 'roadex', name: 'Roadex', root: '/srv/roadex' }],
          sessions: [{
            id: 'session-approval',
            userId: 'owner',
            workspace: { id: 'roadex', name: 'Roadex', root: '/srv/roadex' },
            lifecycle: 'ready',
            runnerMode: 'codex',
            transport: 'sse',
            deviceBridge: 'disabled',
            gates: [],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1).toISOString(),
            waitingApproval: {
              waitId: 'wait-readonly',
              approvalRef: 'admin.roadex.approval',
              subject: 'provisioning a protected operation',
              consoleSurface: 'admin',
              consolePath: '/Overseer/admin',
              state: 'pending',
              updatedAt: new Date(1).toISOString(),
            },
          }],
          auditEvents: [],
          streamPreview: [],
          managedThreads: [],
          deviceBridgePolicy: {
            state: 'disabled',
            approvedFoundation: true,
            operations: ['esp32.flash'],
            requestIntakeEnabled: false,
            descriptorObservationEnabled: false,
            operationsEnabled: false,
            writeEnabled: false,
            reason: 'disabled',
          },
          deviceInventoryBindingRefs: [],
          serialVerificationProfiles: [],
          bleVerificationProfiles: [],
          usbDeviceProfiles: [],
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-roadex-csrf': 'private-test-value',
          },
        });
      }
      return new Response('{"ok":true}', { status: 404 });
    }));

    const { loginAndBootstrap } = await import('../src/client/sessionApi');
    const bootstrap = await loginAndBootstrap();

    expect(bootstrap.bootstrap.sessions[0].waitingApproval).toMatchObject({
      waitId: 'wait-readonly',
      approvalRef: 'admin.roadex.approval',
      subject: 'provisioning a protected operation',
      consoleSurface: 'admin',
      consolePath: '/Overseer/admin',
      state: 'pending',
    });
  });

  it('returns only the exact human-approval-pending prompt conflict', async () => {
    const pending = {
      accepted: false,
      error: {
        code: 'human-approval-pending',
        message: 'Human approval is still pending.',
      },
    } as const;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(pending), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    const { submitPrompt } = await import('../src/client/sessionApi');

    await expect(submitPrompt('session-token', 'session-waiting', 'continue')).resolves.toEqual(pending);
  });

  it.each([
    ['wrong code', { accepted: false, error: { code: 'other-conflict', message: 'Conflict.' } }],
    ['missing accepted flag', { error: { code: 'human-approval-pending', message: 'Conflict.' } }],
    ['extra response field', { accepted: false, error: { code: 'human-approval-pending', message: 'Conflict.' }, retry: true }],
    ['extra error field', { accepted: false, error: { code: 'human-approval-pending', message: 'Conflict.', gate: 'approval' } }],
    ['empty message', { accepted: false, error: { code: 'human-approval-pending', message: '' } }],
    ['arbitrary conflict', { ok: false, reason: 'Conflict.' }],
  ])('rejects an unrecognized prompt 409 payload: %s', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    const { submitPrompt } = await import('../src/client/sessionApi');

    await expect(submitPrompt('session-token', 'session-waiting', 'continue')).rejects.toThrow();
  });
});
