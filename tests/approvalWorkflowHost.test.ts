import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import type { Stats } from 'node:fs';

const MOCK_SOCKET_PATH = '/run/user/1000/roadex-approval-workflow.sock';
const OWNER_UID = process.getuid?.() ?? 0;

const createdServers: MockServer[] = [];

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    chmodSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    realpathSync: (path: string) => path,
    lstatSync: (path: string): Stats => {
      if (path === MOCK_SOCKET_PATH) {
        return {
          uid: OWNER_UID,
          mode: 0o600,
          isSymbolicLink: () => false,
          isSocket: () => true,
          isDirectory: () => false,
        } as Stats;
      }
      if (path === dirname(MOCK_SOCKET_PATH)) {
        return {
          uid: OWNER_UID,
          mode: 0o700,
          isSymbolicLink: () => false,
          isSocket: () => false,
          isDirectory: () => true,
        } as Stats;
      }
      return actual.lstatSync(path);
    },
  };
});

class MockSocket extends EventEmitter {
  public output = '';

  setEncoding(): void {
    // No-op in mocked transport.
  }

  resume(): void {
    // No-op in mocked transport.
  }

  end(payload?: string): void {
    if (typeof payload === 'string') {
      this.output = payload;
    }
    this.emit('close');
  }

  destroy(): void {
    this.emit('close');
  }
}

class MockServer extends EventEmitter {
  private listener?: (socket: MockSocket) => void;

  constructor(listener?: (socket: MockSocket) => void) {
    super();
    this.listener = listener;
    this.setMaxListeners?.(100);
  }

  listen(_path: string, cb?: () => void): this {
    this.emit('listening');
    cb?.();
    return this;
  }

  close(cb?: () => void): void {
    this.emit('close');
    cb?.();
  }

  getSocket(): MockSocket {
    const socket = new MockSocket();
    this.listener?.(socket);
    return socket;
  }
}

vi.mock('node:net', () => {
  return {
    createServer: vi.fn((
      _options: unknown,
      listener?: (socket: MockSocket) => void,
    ) => {
      const handler = typeof _options === 'function'
        ? _options
        : listener;
      const server = new MockServer(handler);
      createdServers.push(server);
      return server as unknown as import('node:net').Server;
    }),
  };
});

import {
  APPROVAL_WORKFLOW_SOCKET,
  startApprovalWorkflowHost,
  type ApprovalWorkflowSocketResult,
} from '../src/server/approvalWorkflowHost';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';
import {
  type ApprovalSessionCapability,
  type RegisterApprovalWaitInput,
} from '../src/server/approvalCoordinator';

function makeCapability(overrides: Partial<ApprovalSessionCapability> = {}): ApprovalSessionCapability {
  const now = new Date().toISOString();
  return {
    sessionId: 'session-1',
    userId: 'owner',
    projectId: 'roadex',
    workspaceId: 'roadex',
    managedThreadId: 'thread-1',
    provider: 'overseer',
    approvalRef: 'admin.workflow.approved',
    resourceRef: 'roadex/roadex/workspace',
    authorityClass: 'privileged-operation',
    consoleSurface: 'admin',
    subject: 'roadex-workflow',
    state: 'pending',
    decisionVersion: 'sha256:abcdef000000000000000000000000000000000000000000000000000000000000',
    continuationId: 'roadex-workflow-resume',
    checkAttempt: 0,
    nextCheckAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  createdServers.length = 0;
});

function getLatestServer(): MockServer {
  const server = createdServers.at(-1);
  if (!server) throw new Error('mock server not created');
  return server;
}

async function waitForSocketOutput(socket: MockSocket): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (socket.output.length > 0) return socket.output;
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  return socket.output;
}

function sendSocketRequest(
  socket: MockSocket,
  chunks: Array<string | Buffer>,
): void {
  for (const chunk of chunks) {
    socket.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  socket.emit('end');
}

function sendSocketFrame(socket: MockSocket, value: string | Buffer): void {
  sendSocketRequest(socket, [value]);
}

function createHostHarness() {
  return {
    async start(callback: Parameters<typeof startApprovalWorkflowHost>[0]) {
      const server = startApprovalWorkflowHost(callback);
      return {
        server,
        createSocket: () => getLatestServer().getSocket(),
      };
    },
  };
}

describe('approval workflow host', () => {
  const socketPath = APPROVAL_WORKFLOW_SOCKET;

  it('rejects non-fixed socket paths in production', () => {
    expect(() => startApprovalWorkflowHost({
      enabled: true,
      socketPath: '/tmp/not-workflow-sock',
      verifyPeer: async () => true,
      resolveRunCapability: async () => undefined,
      register: async () => ({ ok: true, wait: {
        waitId: 'wait-1',
        approvalRef: 'admin.workflow.approved',
        subject: 'roadex-workflow',
        consoleSurface: 'admin',
        state: 'pending',
        updatedAt: new Date().toISOString(),
      } }),
      broker: new ApprovalWorkflowGrantBroker(),
    })).toThrow('host_path_invalid');
  });

  it('accepts one valid request, checks exact bindings, and calls registration once', async () => {
    const harness = createHostHarness();
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    let tokenConsumedBeforeRegistration = false;
    const registerCalls: RegisterApprovalWaitInput[] = [];

    const { server, createSocket } = await harness.start({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      broker,
      resolveRunCapability: async (runId) => runId === 'run-1' ? makeCapability() : undefined,
      register: async () => {
        tokenConsumedBeforeRegistration = broker.consume(grant.token) === undefined;
        registerCalls.push({ provider: 'overseer', approvalRef: 'admin.workflow.approved' });
        return {
          ok: true,
          wait: {
            waitId: 'wait-1',
            approvalRef: 'admin.workflow.approved',
            subject: 'roadex-workflow',
            consoleSurface: 'admin',
            state: 'pending',
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    const socket = createSocket();
    sendSocketFrame(socket, `${JSON.stringify({
      token: grant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })}\n`);
    const output = await waitForSocketOutput(socket);
    const parsed = JSON.parse(output || '{}') as ApprovalWorkflowSocketResult;
    expect(parsed).toMatchObject({ ok: true, wait: { waitId: 'wait-1', approvalRef: 'admin.workflow.approved' } });
    expect(tokenConsumedBeforeRegistration).toBe(true);
    expect(registerCalls).toEqual([{ provider: 'overseer', approvalRef: 'admin.workflow.approved' }]);
    expect(JSON.stringify(parsed)).not.toContain(grant.token);
    expect(broker.consume(grant.token)).toBeUndefined();
    server.close();
  });

  it('rejects malformed fields, missing exact keys, and non-objects', async () => {
    const harness = createHostHarness();
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-2',
      workspaceId: 'roadex',
      managedThreadId: 'thread-2',
      runId: 'run-2',
    });
    const registerCalls: RegisterApprovalWaitInput[] = [];

    const { createSocket } = await harness.start({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      broker,
      resolveRunCapability: async (runId) => runId === 'run-2' ? makeCapability({
        sessionId: 'session-2',
        projectId: 'roadex',
        workspaceId: 'roadex',
        managedThreadId: 'thread-2',
      }) : undefined,
      register: async () => {
        registerCalls.push({ provider: 'overseer', approvalRef: 'admin.workflow.approved' });
        return { ok: false, code: 'scope-mismatch' };
      },
    });

    const malformedShapeSocket = createSocket();
    sendSocketFrame(malformedShapeSocket, `${JSON.stringify({
      token: grant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
      extra: true,
    })}\n`);
    expect(JSON.parse(await waitForSocketOutput(malformedShapeSocket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });

    const missingKeySocket = createSocket();
    sendSocketFrame(missingKeySocket, `${JSON.stringify({
      token: grant.token,
      approvalRef: 'admin.workflow.approved',
    })}\n`);
    expect(JSON.parse(await waitForSocketOutput(missingKeySocket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });

    const nullSocket = createSocket();
    sendSocketFrame(nullSocket, 'null\n');
    expect(JSON.parse(await waitForSocketOutput(nullSocket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });

    const arraySocket = createSocket();
    sendSocketFrame(arraySocket, '[1,2,3]\n');
    expect(JSON.parse(await waitForSocketOutput(arraySocket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });

    const oversizedSocket = createSocket();
    sendSocketFrame(oversizedSocket, `${JSON.stringify({
      token: grant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
      padding: 'x'.repeat(5_000),
    })}\n`);
    expect(JSON.parse(await waitForSocketOutput(oversizedSocket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });

    const malformedJsonSocket = createSocket();
    sendSocketFrame(malformedJsonSocket, '{\n');
    expect(JSON.parse(await waitForSocketOutput(malformedJsonSocket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });

    expect(registerCalls).toHaveLength(0);
  });

  it('denies untrusted peers and requires active exact run/session bindings', async () => {
    const firstGrant = new ApprovalWorkflowGrantBroker();
    const peerGrant = firstGrant.issue({
      userId: 'owner',
      sessionId: 'session-3',
      workspaceId: 'roadex',
      managedThreadId: 'thread-3',
      runId: 'run-3',
    });

    const { createSocket: createPeerSocket } = await createHostHarness().start({
      enabled: true,
      socketPath,
      verifyPeer: async () => false,
      broker: firstGrant,
      resolveRunCapability: async () => makeCapability(),
      register: async () => ({
        ok: true,
        wait: {
          waitId: 'wait-1',
          approvalRef: 'admin.workflow.approved',
          subject: 'roadex-workflow',
          consoleSurface: 'admin',
          state: 'pending',
          updatedAt: new Date().toISOString(),
        },
      }),
    });

    const peerSocket = createPeerSocket();
    sendSocketFrame(peerSocket, `${JSON.stringify({
      token: peerGrant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })}\n`);
    expect(JSON.parse(await waitForSocketOutput(peerSocket) || '{}')).toMatchObject({ ok: false, code: 'peer_denied' });

    const secondGrant = new ApprovalWorkflowGrantBroker();
    const driftGrant = secondGrant.issue({
      userId: 'owner',
      sessionId: 'session-4',
      workspaceId: 'roadex',
      managedThreadId: 'thread-4',
      runId: 'run-4',
    });
    const { createSocket: createRunSocket } = await createHostHarness().start({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      broker: secondGrant,
      resolveRunCapability: async () => undefined,
      register: async () => ({
        ok: true,
        wait: {
          waitId: 'wait-2',
          approvalRef: 'admin.workflow.approved',
          subject: 'roadex-workflow',
          consoleSurface: 'admin',
          state: 'pending',
          updatedAt: new Date().toISOString(),
        },
      }),
    });
    const runSocket = createRunSocket();
    sendSocketFrame(runSocket, `${JSON.stringify({
      token: driftGrant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })}\n`);
    expect(JSON.parse(await waitForSocketOutput(runSocket) || '{}')).toMatchObject({ ok: false, code: 'run_not_active' });
  });

  it('rejects workspace drift even when projectId still matches and never registers', async () => {
    const harness = createHostHarness();
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-drift',
      workspaceId: 'roadex',
      managedThreadId: 'thread-drift',
      runId: 'run-drift',
    });
    let registerCalled = false;

    const { createSocket } = await harness.start({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      broker,
      resolveRunCapability: async (runId) => runId === 'run-drift' ? makeCapability({
        sessionId: 'session-drift',
        projectId: 'roadex',
        workspaceId: 'roadex-alt',
        managedThreadId: 'thread-drift',
      }) : undefined,
      register: async () => {
        registerCalled = true;
        return {
          ok: true,
          wait: {
            waitId: 'wait-1',
            approvalRef: 'admin.workflow.approved',
            subject: 'roadex-workflow',
            consoleSurface: 'admin',
            state: 'pending',
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    const socket = createSocket();
    sendSocketFrame(socket, `${JSON.stringify({
      token: grant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })}\n`);
    expect(JSON.parse(await waitForSocketOutput(socket) || '{}')).toMatchObject({
      ok: false,
      code: 'scope_mismatch',
    });
    expect(registerCalled).toBe(false);
  });

  it('rejects malformed coordinator waits and bounds wait fields', async () => {
    const harness = createHostHarness();
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-5',
      workspaceId: 'roadex',
      managedThreadId: 'thread-5',
      runId: 'run-5',
    });

    const { createSocket } = await harness.start({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      broker,
      resolveRunCapability: async (runId) => runId === 'run-5' ? makeCapability({
        sessionId: 'session-5',
        managedThreadId: 'thread-5',
      }) : undefined,
      register: async () => ({
        ok: true,
        wait: {
          waitId: 'w'.repeat(8_000),
          approvalRef: 'admin.workflow.approved',
          subject: 'roadex-workflow',
          consoleSurface: 'admin',
          state: 'pending',
          updatedAt: new Date().toISOString(),
        },
      }),
    });

    const socket = createSocket();
    sendSocketFrame(socket, `${JSON.stringify({
      token: grant.token,
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })}\n`);
    const parsed = JSON.parse(await waitForSocketOutput(socket) || '{}') as ApprovalWorkflowSocketResult;
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.wait.waitId).toHaveLength(2000);
  });

  it('rejects trailing chunks after a valid request frame and does not register', async () => {
    const harness = createHostHarness();
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-trailing',
      workspaceId: 'roadex',
      managedThreadId: 'thread-trailing',
      runId: 'run-trailing',
    });
    let registerCalls = 0;

    const { createSocket } = await harness.start({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      broker,
      resolveRunCapability: async (runId) => runId === 'run-trailing' ? makeCapability({
        sessionId: 'session-trailing',
        workspaceId: 'roadex',
        managedThreadId: 'thread-trailing',
      }) : undefined,
      register: async () => {
        registerCalls += 1;
        return {
          ok: true,
          wait: {
            waitId: 'wait-trailing',
            approvalRef: 'admin.workflow.approved',
            subject: 'roadex-workflow',
            consoleSurface: 'admin',
            state: 'pending',
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    const socket = createSocket();
    sendSocketRequest(socket, [
      `${JSON.stringify({
        token: grant.token,
        provider: 'overseer',
        approvalRef: 'admin.workflow.approved',
      })}\n`,
      'trailing',
    ]);
    expect(JSON.parse(await waitForSocketOutput(socket) || '{}')).toMatchObject({
      ok: false,
      code: 'request_invalid',
    });
    expect(registerCalls).toBe(0);
    expect(broker.consume(grant.token)).toBeDefined();
  });
});
