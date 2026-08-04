import { createConnection, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApprovalCoordinatorCallbacks,
  type ApprovalSessionCapability,
  ApprovalCoordinator,
} from '../src/server/approvalCoordinator';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';
import { createProductionApprovalWorkflowHostDependencies } from '../src/server/approvalWorkflowComposition';
import { createApprovalWorkflowRunRuntime } from '../src/server/sessionService';
import { startApprovalWorkflowHost } from '../src/server/approvalWorkflowHost';
import type { ApprovalStageLocator } from '../src/server/approvalWorkflowMcp';
import type { ApprovalWaitRecord, NormalizedApprovalStatus } from '../src/shared/approvalWorkflowContracts';
import type { RoadexSession } from '../src/shared/sessionContracts';
import { validProvisioningIntent } from './approvalFixtures';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type ApprovalWorkflowResponse = { ok: boolean; waitId?: string; waitState?: string; reason?: string };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

function fixtureSession(): RoadexSession {
  return {
    id: 'session-1',
    userId: 'owner',
    workspace: { id: 'roadex', name: 'Roadex', root: '/roadex' },
    lifecycle: 'ready',
    runnerMode: 'codex',
    transport: 'websocket',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    codexThreadId: 'thread-1',
    managedThreadId: 'thread-1',
  };
}

function fixtureStatus(): NormalizedApprovalStatus {
  return {
    provider: 'overseer',
    approvalRef: 'approval.fixture.v1',
    authorityClass: 'project-workflow',
    decision: 'pending',
    decisionVersion: `sha256:${'a'.repeat(64)}`,
    projectId: 'roadex',
    workspaceId: 'roadex',
    resourceRef: 'resource-1',
    subject: 'Roadex approval',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };
}

function fixtureLocator(): ApprovalStageLocator {
  return {
    provider: 'overseer',
    approvalRef: 'approval.fixture.v1',
    projectId: 'roadex',
    workspaceId: 'roadex',
    resourceRef: 'resource-1',
    authorityClass: 'project-workflow',
    scopeDigest: `sha256:${'a'.repeat(64)}`,
  };
}

function callbacks(persist: () => void | Promise<void>): ApprovalCoordinatorCallbacks {
  return {
    persist,
    publish: () => {},
    audit: () => {},
    queueContinuation: async () => ({ status: 'started', runnerRunId: 'runner-1' }),
  };
}

describe('approval workflow timeout race', () => {
  let socketRoot = '';
  let socketPath = '';

  beforeEach(() => {
    socketRoot = mkdtempSync(join(tmpdir(), 'roadex-approval-timeout-race-'));
    socketPath = join(socketRoot, 'workflow.sock');
  });

  afterEach(() => {
    rmSync(socketRoot, { recursive: true, force: true });
  });

  it('returns request_timeout and leaves no wait when real registration is delayed past host timeout', async () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const capability: ApprovalSessionCapability = {
      sessionId: 'session-1',
      userId: 'owner',
      projectId: 'roadex',
      workspaceId: 'roadex',
      resourceRef: 'resource-1',
      managedThreadId: 'thread-1',
    };
    const session = fixtureSession();
    const waits: ApprovalWaitRecord[] = [];
    const statusGate = deferred<NormalizedApprovalStatus>();
    const coordinator = new ApprovalCoordinator(
      waits,
      [session],
      { getStatus: vi.fn(async () => statusGate.promise) },
      callbacks(() => {}),
      { idSource: { generateWaitId: () => 'wait-race' } },
    );
    const runtime = createApprovalWorkflowRunRuntime(broker, {
      stageTypedIntent: async () => fixtureLocator(),
    });
    const grant = runtime.beginRun(capability);
    const dependencies = createProductionApprovalWorkflowHostDependencies({
      broker,
      runtime,
      socketPath,
      registerApprovalWait: (run, input, signal) => coordinator.register(run, input, signal),
    });
    const host = startApprovalWorkflowHost({
      ...dependencies,
      registerApprovalWait: (run, input, signal) => coordinator.register(run, input, signal),
      verifyPeer: async () => true,
      requestTimeoutMs: 25,
    });
    await waitForListening(host);
    try {
      const responsePromise = sendRequest(socketPath, { token: grant.token });
      await expect(responsePromise).resolves.toEqual({ ok: false, reason: 'request_timeout' });
      statusGate.resolve(fixtureStatus());
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(waits).toHaveLength(0);
      expect(session.lifecycle).toBe('ready');
      expect(session.waitingApproval).toBeUndefined();
    } finally {
      await closeServer(host);
    }
  });
});

function waitForListening(server: Server): Promise<void> {
  return server.listening ? Promise.resolve() : new Promise((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function sendRequest(path: string, input: { token: string }): Promise<ApprovalWorkflowResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.once('connect', () => {
      socket.end(JSON.stringify({
        token: input.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      }) + '\n');
    });
    socket.on('data', (chunk) => { output += chunk.toString('utf8'); });
    socket.once('end', () => {
      try {
        resolve(JSON.parse(output.trim()) as ApprovalWorkflowResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}
