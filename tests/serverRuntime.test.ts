import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockAuthToken, mockUser } from '../src/server/authService';
import { createInitialState } from '../src/server/sessionService';
import { createMemoryPersistence } from '../src/server/statePersistence';
import { APPROVAL_WORKFLOW_SOCKET, type ApprovalWorkflowHostOptions } from '../src/server/approvalWorkflowHost';
import { verifyLinuxPeerCredentials } from '../src/server/controlledOperationsPeer';
import { resolveApprovalPollMs, startRoadexRuntime } from '../server/index';
import type { RoadexSession } from '../src/shared/sessionContracts';

const autoHttpServer = vi.hoisted(() => ({
  listen: vi.fn((_port: number, _host: string, callback?: () => void) => callback?.()),
  close: vi.fn((callback?: () => void) => callback?.()),
}));

const runtimeTokenDirectories: string[] = [];

async function createRuntimeTokenFile(token: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'roadex-runtime-token-'));
  runtimeTokenDirectories.push(directory);
  await chmod(directory, 0o700);
  const path = join(directory, 'approval-status.token');
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

afterEach(async () => {
  for (const directory of runtimeTokenDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  createServer: vi.fn(() => autoHttpServer),
}));

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function session(): RoadexSession {
  return {
    id: 'session-runtime-close',
    userId: mockUser.id,
    workspace: { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
    lifecycle: 'paused',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: '2026-08-02T20:00:00.000Z',
    updatedAt: '2026-08-02T20:00:00.000Z',
  };
}

function responseRecorder(order: string[]) {
  return Object.assign(new EventEmitter(), {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(body = '') {
      order.push('response:end');
      this.body = String(body);
      this.emit('finish');
      return this;
    },
    write() { return true; },
  });
}

function request(path: string) {
  return Object.assign(Readable.from([]), {
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${mockAuthToken}`, host: 'localhost' },
  });
}

describe('Roadex approval runtime', () => {
  it('constructs canonical coordinator callbacks and keeps provider credentials out of state', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(undefined, persistence);
    const target = session();
    target.managedThreadId = 'managed-runtime-callbacks';
    target.codexThreadId = target.managedThreadId;
    target.lifecycle = 'ready';
    state.sessions.sessions.push(target);
    const secret = 'runtime_callback_secret_1234567890';
    const secretPath = await createRuntimeTokenFile(secret);

    const runtime = await startRoadexRuntime({
      state,
      env: {
        ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: secretPath,
        ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN: 'legacy_direct_secret_must_not_be_used',
      },
      createApprovalProvider: (options) => ({
        getStatus: async (approvalRef, scope) => {
          expect(options.readToken()).toBe(secret);
          return {
            provider: 'overseer',
            approvalRef,
            authorityClass: 'privileged-operation',
            decision: 'pending',
            decisionVersion: `sha256:${'a'.repeat(64)}`,
            projectId: scope.projectId,
            workspaceId: scope.workspaceId,
            resourceRef: scope.resourceRef,
            subject: 'Approve runtime callback construction',
            updatedAt: '2026-08-02T20:00:00.000Z',
          };
        },
      }),
      startWorkflowHost: () => ({ close: vi.fn(async () => undefined) }),
      startHttp: () => ({ close: vi.fn(async () => undefined) }),
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
      log: vi.fn(),
    });

    await expect(runtime.coordinator.register({
      sessionId: target.id,
      userId: target.userId,
      projectId: target.workspace.id,
      workspaceId: target.workspace.id,
      resourceRef: 'admin.runtime-callbacks',
      managedThreadId: target.managedThreadId,
    }, { provider: 'overseer', approvalRef: 'admin.runtime-callbacks' })).resolves.toMatchObject({ ok: true });

    expect(state.sessions.streamEvents.at(-1)).toMatchObject({
      sessionId: target.id,
      kind: 'system',
      message: 'Roadex is waiting for human approval in Admin Console. Roadex will continue automatically after verified approval.',
    });
    expect(state.audit.events.at(-1)).toMatchObject({
      actorId: 'roadex-approval-coordinator',
      action: 'approval_wait.register',
    });
    expect(persistence.load().approvalWaits).toHaveLength(1);
    expect(JSON.stringify(persistence.load())).not.toContain(secret);
    expect(JSON.stringify(persistence.load())).not.toContain(secretPath);
    expect(JSON.stringify(runtime)).not.toContain(secret);
    expect(JSON.stringify(runtime)).not.toContain(secretPath);
    await runtime.shutdown();
  });

  it('starts the fixed workflow host, recovers once, then listens and schedules unref non-overlapping ticks', async () => {
    const order: string[] = [];
    const state = createInitialState(undefined, createMemoryPersistence());
    const tickGate = deferred();
    const coordinator = {
      recover: vi.fn(async () => { order.push('recover'); }),
      tick: vi.fn(() => tickGate.promise),
      closeSessionWait: vi.fn(async () => undefined),
      hasActiveWait: vi.fn(() => false),
      completeContinuation: vi.fn(async () => ({ status: 'stale' as const })),
      register: vi.fn(async () => ({ ok: false as const, code: 'provider-unavailable' as const })),
    };
    const workflowHost = { close: vi.fn(async () => { order.push('workflow:close'); }) };
    const httpHost = { close: vi.fn(async () => { order.push('http:close'); }) };
    const timer = { unref: vi.fn() };
    let scheduled!: () => void;
    let hostOptions: ApprovalWorkflowHostOptions | undefined;
    let tokenReader!: () => string;
    const secret = 'runtime_secret_token_123456789012';
    const secretPath = await createRuntimeTokenFile(secret);

    const runtime = await startRoadexRuntime({
      state,
      env: {
        HOST: '127.0.0.1',
        PORT: '8780',
        ROADEX_APPROVAL_POLL_MS: '2500',
        ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE: secretPath,
      },
      createApprovalProvider(options) {
        order.push('provider');
        tokenReader = options.readToken;
        return { getStatus: vi.fn() };
      },
      coordinator,
      startWorkflowHost(options) {
        order.push('workflow:start');
        hostOptions = options;
        return workflowHost;
      },
      startHttp(handler, address) {
        order.push(`http:${address.host}:${address.port}`);
        expect(typeof handler).toBe('function');
        return httpHost;
      },
      setInterval(callback, milliseconds) {
        order.push(`interval:${milliseconds}`);
        scheduled = callback;
        return timer;
      },
      clearInterval: vi.fn(() => { order.push('interval:clear'); }),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
      log: vi.fn(),
    });

    expect(order.slice(0, 4)).toEqual(['provider', 'workflow:start', 'recover', 'http:127.0.0.1:8780']);
    expect(coordinator.recover).toHaveBeenCalledTimes(1);
    expect(hostOptions).toMatchObject({ enabled: true, socketPath: APPROVAL_WORKFLOW_SOCKET });
    if (!hostOptions) return;
    expect(hostOptions.verifyPeer).toBe(verifyLinuxPeerCredentials);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(tokenReader()).toBe(secret);
    expect(JSON.stringify(runtime)).not.toContain(secret);
    expect(JSON.stringify(runtime)).not.toContain(secretPath);

    scheduled();
    scheduled();
    expect(coordinator.tick).toHaveBeenCalledTimes(1);
    tickGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    scheduled();
    expect(coordinator.tick).toHaveBeenCalledTimes(2);
  });

  it('bridges exact active capabilities and retires a wait before completing a close response', async () => {
    const state = createInitialState(undefined, createMemoryPersistence());
    const target = session();
    state.sessions.sessions.push(target);
    state.activeApprovalRuns.set('run-11111111111111111111111111111111', {
      capability: {
        sessionId: target.id,
        userId: target.userId,
        projectId: target.workspace.id,
        workspaceId: target.workspace.id,
        resourceRef: 'admin.runtime-operation',
        managedThreadId: 'managed-runtime-thread',
      },
    });
    const order: string[] = [];
    const coordinator = {
      recover: vi.fn(async () => undefined),
      tick: vi.fn(async () => undefined),
      closeSessionWait: vi.fn(async () => { order.push('wait:retired'); }),
      hasActiveWait: vi.fn(() => true),
      completeContinuation: vi.fn(async () => ({ status: 'stale' as const })),
      register: vi.fn(async () => ({ ok: false as const, code: 'provider-unavailable' as const })),
    };
    let hostOptions: ApprovalWorkflowHostOptions | undefined;
    let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

    const runtime = await startRoadexRuntime({
      state,
      env: {},
      createApprovalTokenReader: () => () => 'runtime_test_token_123456789012345',
      coordinator,
      createApprovalProvider: () => ({ getStatus: vi.fn() }),
      startWorkflowHost(options) {
        hostOptions = options;
        return { close: vi.fn(async () => undefined) };
      },
      startHttp(candidate) {
        handler = candidate;
        return { close: vi.fn(async () => undefined) };
      },
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
      log: vi.fn(),
    });

    expect(hostOptions).toBeDefined();
    if (!hostOptions) return;
    await expect(Promise.resolve(hostOptions.resolveRunCapability('run-11111111111111111111111111111111'))).resolves.toEqual({
      sessionId: target.id,
      userId: target.userId,
      projectId: target.workspace.id,
      workspaceId: target.workspace.id,
      resourceRef: 'admin.runtime-operation',
      managedThreadId: 'managed-runtime-thread',
    });
    await expect(Promise.resolve(hostOptions.resolveRunCapability('run-other'))).resolves.toBeUndefined();

    const res = responseRecorder(order);
    await handler(
      request(`/api/sessions/${target.id}/close`) as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(coordinator.closeSessionWait).toHaveBeenCalledWith(target.id);
    expect(order).toEqual(['wait:retired', 'response:end']);
    expect(target.lifecycle).toBe('closed');
    expect(res.statusCode).toBe(202);
    expect(runtime.state).toBe(state);
  });

  it('shuts down once in clear-host-revoke-http order and blocks later ticks', async () => {
    const order: string[] = [];
    const state = createInitialState(undefined, createMemoryPersistence());
    state.activeApprovalRuns.set('run-22222222222222222222222222222222', {
      capability: {
        sessionId: 'session-2', userId: 'user-2', projectId: 'roadex', workspaceId: 'roadex',
        resourceRef: 'admin.runtime-operation', managedThreadId: 'managed-2',
      },
    });
    const coordinator = {
      recover: vi.fn(async () => undefined), tick: vi.fn(async () => undefined),
      closeSessionWait: vi.fn(async () => undefined), hasActiveWait: vi.fn(() => false),
      completeContinuation: vi.fn(async () => ({ status: 'stale' as const })),
      register: vi.fn(async () => ({ ok: false as const, code: 'provider-unavailable' as const })),
    };
    let scheduled!: () => void;
    const runtime = await startRoadexRuntime({
      state,
      env: {},
      createApprovalTokenReader: () => () => 'runtime_test_token_123456789012345',
      coordinator,
      createApprovalProvider: () => ({ getStatus: vi.fn() }),
      startWorkflowHost: () => ({ close: vi.fn(async () => { order.push('workflow:close'); }) }),
      startHttp: () => ({ close: vi.fn(async () => { order.push('http:close'); }) }),
      setInterval(callback) { scheduled = callback; return { unref: vi.fn() }; },
      clearInterval: vi.fn(() => { order.push('interval:clear'); }),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
      log: vi.fn(),
    });
    vi.spyOn(runtime.broker, 'revokeRun').mockImplementation((runId) => { order.push(`revoke:${runId}`); });

    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    scheduled();
    await Promise.resolve();

    expect(order).toEqual([
      'interval:clear',
      'workflow:close',
      'revoke:run-22222222222222222222222222222222',
      'http:close',
    ]);
    expect(coordinator.tick).not.toHaveBeenCalled();
  });

  it('does not start HTTP when token-reader setup, workflow startup, or recovery fails', async () => {
    const startHttp = vi.fn();
    const base = {
      state: createInitialState(undefined, createMemoryPersistence()),
      env: {}, startHttp,
      createApprovalTokenReader: () => () => 'runtime_test_token_123456789012345',
      setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn(),
      addSignalListener: vi.fn(), removeSignalListener: vi.fn(), log: vi.fn(),
    };

    await expect(startRoadexRuntime({
      ...base,
      createApprovalTokenReader: () => { throw new Error('token-reader-setup-failed'); },
    })).rejects.toThrow('approval_runtime_start_failed');
    await expect(startRoadexRuntime({
      ...base,
      startWorkflowHost: () => { throw new Error('workflow-start-failed'); },
    })).rejects.toThrow('approval_runtime_start_failed');
    await expect(startRoadexRuntime({
      ...base,
      startWorkflowHost: () => ({ close: vi.fn(async () => undefined) }),
      coordinator: {
        recover: vi.fn(async () => { throw new Error('recovery-failed'); }), tick: vi.fn(),
        closeSessionWait: vi.fn(), hasActiveWait: vi.fn(), completeContinuation: vi.fn(), register: vi.fn(),
      },
    })).rejects.toThrow('approval_runtime_start_failed');
    expect(startHttp).not.toHaveBeenCalled();
  });

  it('fails closed when only the legacy direct secret environment value is configured', async () => {
    const startHttp = vi.fn();

    await expect(startRoadexRuntime({
      state: createInitialState(undefined, createMemoryPersistence()),
      env: { ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN: 'legacy_direct_secret_123456789012345' },
      createApprovalProvider: () => ({ getStatus: vi.fn() }),
      startWorkflowHost: () => ({ close: vi.fn(async () => undefined) }),
      startHttp,
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
      log: vi.fn(),
    })).rejects.toThrow('approval_runtime_start_failed');

    expect(startHttp).not.toHaveBeenCalled();
  });

  it('contains no production fallback to a direct secret environment value', async () => {
    const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN(?!_FILE)/);
  });

  it('parses only bounded positive polling intervals', () => {
    expect(resolveApprovalPollMs(undefined)).toBe(2000);
    expect(resolveApprovalPollMs('2500')).toBe(2500);
    for (const malformed of ['', '0', '1', '-1', '1.5', 'abc', '60001']) {
      expect(resolveApprovalPollMs(malformed)).toBe(2000);
    }
  });
});
