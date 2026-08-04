import { createConnection, createServer, type Server } from 'node:net';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';
import { startApprovalWorkflowHost } from '../src/server/approvalWorkflowHost';
import type { ApprovalStageLocator } from '../src/server/approvalWorkflowMcp';
import { validProvisioningIntent } from './approvalFixtures';
import type {
  ApprovalSessionCapability,
  RegisterApprovalWaitInput,
  RegisterApprovalWaitResult,
} from '../src/server/approvalCoordinator';

const WAIT: RegisterApprovalWaitResult = {
  ok: true,
  wait: {
    waitId: 'wait-1',
    approvalRef: 'admin.roadex.test',
    subject: 'Roadex approval',
    consoleSurface: 'admin',
    state: 'pending',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

let socketRoot = '';
let socketPath = '';

beforeEach(() => {
  socketRoot = mkdtempSync(join(tmpdir(), 'roadex-approval-workflow-host-'));
  socketPath = join(socketRoot, 'workflow.sock');
});

afterEach(() => {
  rmSync(socketRoot, { recursive: true, force: true });
});

describe('approval workflow host listener', () => {
  it('stages typed intent, validates the returned locator, and registers only its approval reference', async () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    const runContext: ApprovalSessionCapability = {
      sessionId: 'session-1',
      userId: 'owner',
      projectId: 'roadex',
      workspaceId: 'roadex',
      resourceRef: 'resource-1',
      managedThreadId: 'thread-1',
    };
    const staged: unknown[] = [];
    const registered: unknown[] = [];
    const locator = {
      provider: 'overseer',
      approvalRef: 'approval.fixture.v1',
      projectId: 'roadex',
      workspaceId: 'roadex',
      resourceRef: 'resource-1',
      authorityClass: 'project-workflow',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
    };
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: (runId) => runId === 'run-1' ? runContext : undefined,
      stageTypedIntent: async (capability, intent) => {
        staged.push({ capability, intent });
        return locator;
      },
      registerApprovalWait: async (capability, input) => {
        registered.push({ capability, input });
        return WAIT;
      },
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      const response = await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      });
      expect(response).toEqual({ ok: true, waitId: 'wait-1', waitState: 'pending' });
      expect(staged).toEqual([{
        capability: runContext,
        intent: validProvisioningIntent(),
      }]);
      expect(registered).toEqual([{
        capability: runContext,
        input: { provider: 'overseer', approvalRef: 'approval.fixture.v1' },
      }]);
    } finally {
      await closeServer(host);
    }
  });

  it('fails closed when the authoritative locator scope differs from the managed run', async () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    const runContext: ApprovalSessionCapability = {
      sessionId: 'session-1',
      userId: 'owner',
      projectId: 'roadex',
      workspaceId: 'roadex',
      resourceRef: 'resource-1',
      managedThreadId: 'thread-1',
    };
    let registrations = 0;
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: () => runContext,
      stageTypedIntent: async () => ({
        provider: 'overseer',
        approvalRef: 'approval.fixture.mismatch',
        projectId: 'other-project',
        workspaceId: 'roadex',
        resourceRef: 'resource-1',
        authorityClass: 'project-workflow',
        scopeDigest: `sha256:${'b'.repeat(64)}`,
      }),
      registerApprovalWait: async () => {
        registrations += 1;
        return WAIT;
      },
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      await expect(sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      })).resolves.toEqual({ ok: false, reason: 'scope_mismatch' });
      expect(registrations).toBe(0);
    } finally {
      await closeServer(host);
    }
  });

  it('registers waits only for exact scope and run binding', async () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    const requested: Array<{ capability: ApprovalSessionCapability; input: RegisterApprovalWaitInput }> = [];
    const runContext: ApprovalSessionCapability = {
      sessionId: 'session-1',
      userId: 'owner',
      projectId: 'roadex',
      workspaceId: 'roadex',
      resourceRef: 'resource-1',
      managedThreadId: 'thread-1',
    };
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: (runId) => runId === 'run-1' ? runContext : undefined,
      stageTypedIntent: async () => ({
        provider: 'overseer', approvalRef: 'admin.roadex.test', projectId: 'roadex',
        workspaceId: 'roadex', resourceRef: 'resource-1', authorityClass: 'privileged-operation',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
      }),
      registerApprovalWait: async (capability, input) => {
        requested.push({ capability, input });
        return WAIT;
      },
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      const response = await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      });
      expect(response).toEqual({ ok: true, waitId: 'wait-1', waitState: 'pending' });
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({
        capability: runContext,
        input: { provider: 'overseer', approvalRef: 'admin.roadex.test' },
      });
    } finally {
      await closeServer(host);
    }
  });

  it('denies peer mismatch before any grant callback', async () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    let consumed = 0;
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => {
        consumed += 1;
        return broker.consume(token);
      },
      resolveRunContext: () => undefined,
      registerApprovalWait: async () => WAIT,
      verifyPeer: async () => false,
    });
    await waitForListening(host);
    try {
      const response = await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      });
      expect(response).toEqual({ ok: false, reason: 'peer_denied' });
      expect(consumed).toBe(0);
    } finally {
      await closeServer(host);
    }
  });

  it('rejects malformed input and scope mismatches', async () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    let consumed = 0;
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => {
        consumed += 1;
        return broker.consume(token);
      },
      resolveRunContext: () => undefined,
      registerApprovalWait: async () => WAIT,
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      expect(await sendApprovalWorkflowRequest({ token: 'bad token', provider: 'overseer', approvalRef: 'admin.roadex.test' }))
        .toEqual({ ok: false, reason: 'request_invalid' });
      expect(consumed).toBe(0);

      expect(await sendApprovalWorkflowRequest({ token: 'a'.repeat(42), provider: 'overseer', intent: validProvisioningIntent() }))
        .toEqual({ ok: false, reason: 'request_invalid' });
      expect(await sendApprovalWorkflowRequest({ token: `${'a'.repeat(42)}.`, provider: 'overseer', intent: validProvisioningIntent() }))
        .toEqual({ ok: false, reason: 'request_invalid' });
      expect(await sendApprovalWorkflowRequest({ token: `${'A'.repeat(42)}B`, provider: 'overseer', intent: validProvisioningIntent() }))
        .toEqual({ ok: false, reason: 'request_invalid' });
      expect(consumed).toBe(0);

      expect(await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
        extra: 'field',
      } as never)).toEqual({ ok: false, reason: 'request_invalid' });
      expect(consumed).toBe(0);

      expect(await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      })).toEqual({ ok: false, reason: 'scope_mismatch' });
      expect(consumed).toBe(1);
    } finally {
      await closeServer(host);
    }
  });

  it('requires one complete bounded newline request', async () => {
    let consumed = 0;
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: () => {
        consumed += 1;
        return undefined;
      },
      resolveRunContext: () => undefined,
      registerApprovalWait: async () => WAIT,
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      expect(await sendRawApprovalWorkflowRequest(`${'x'.repeat(4_096)}\n`))
        .toEqual({ ok: false, reason: 'request_too_large' });
      expect(await sendRawApprovalWorkflowRequest(`${JSON.stringify({
        token: 'A'.repeat(43),
        provider: 'overseer',
        intent: validProvisioningIntent(),
      })}\n{}\n`)).toEqual({ ok: false, reason: 'request_invalid' });
      expect(consumed).toBe(0);
    } finally {
      await closeServer(host);
    }
  });

  it('consumes before registration and returns one redacted error when registration rejects', async () => {
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    const runContext: ApprovalSessionCapability = {
      sessionId: 'session-1',
      userId: 'owner',
      projectId: 'roadex',
      workspaceId: 'roadex',
      resourceRef: 'resource-1',
      managedThreadId: 'thread-1',
    };
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: () => runContext,
      stageTypedIntent: async () => ({
        provider: 'overseer', approvalRef: 'admin.roadex.test', projectId: 'roadex',
        workspaceId: 'roadex', resourceRef: 'resource-1', authorityClass: 'privileged-operation',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
      }),
      registerApprovalWait: async () => {
        throw new Error(`private ${grant.token}`);
      },
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      const response = await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      });
      expect(response).toEqual({ ok: false, reason: 'workflow_request_failed' });
      expect(JSON.stringify(response)).not.toContain(grant.token);
      expect(broker.consume(grant.token)).toBeUndefined();
    } finally {
      await closeServer(host);
    }
  });

  it('bounds a registration callback that never settles', async () => {
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: () => ({
        sessionId: 'session-1',
        userId: 'owner',
        projectId: 'roadex',
        workspaceId: 'roadex',
        resourceRef: 'resource-1',
        managedThreadId: 'thread-1',
      }),
      stageTypedIntent: async () => ({
        provider: 'overseer', approvalRef: 'admin.roadex.test', projectId: 'roadex',
        workspaceId: 'roadex', resourceRef: 'resource-1', authorityClass: 'privileged-operation',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
      }),
      registerApprovalWait: async () => new Promise<RegisterApprovalWaitResult>(() => {}),
      verifyPeer: async () => true,
      requestTimeoutMs: 25,
    });
    await waitForListening(host);
    try {
      expect(await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      })).toEqual({ ok: false, reason: 'request_timeout' });
    } finally {
      await closeServer(host);
    }
  });

  it('never registers a wait when staging resolves after the request timeout', async () => {
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue({
      userId: 'owner',
      sessionId: 'session-1',
      workspaceId: 'roadex',
      managedThreadId: 'thread-1',
      runId: 'run-1',
    });
    let releaseStage: ((locator: ApprovalStageLocator) => void) | undefined;
    let stageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { stageStarted = resolve; });
    let registrations = 0;
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: () => ({
        sessionId: 'session-1',
        userId: 'owner',
        projectId: 'roadex',
        workspaceId: 'roadex',
        resourceRef: 'resource-1',
        managedThreadId: 'thread-1',
      }),
      stageTypedIntent: async (_capability, _intent, signal) => {
        stageStarted?.();
        return new Promise<ApprovalStageLocator>((resolve) => {
          releaseStage = resolve;
          signal?.addEventListener('abort', () => undefined, { once: true });
        });
      },
      registerApprovalWait: async () => {
        registrations += 1;
        return WAIT;
      },
      verifyPeer: async () => true,
      requestTimeoutMs: 25,
    });
    await waitForListening(host);
    try {
      const responsePromise = sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        intent: validProvisioningIntent(),
      });
      await started;
      await expect(responsePromise).resolves.toEqual({ ok: false, reason: 'request_timeout' });
      releaseStage?.({
        provider: 'overseer',
        approvalRef: 'approval.late',
        projectId: 'roadex',
        workspaceId: 'roadex',
        resourceRef: 'resource-1',
        authorityClass: 'project-workflow',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(registrations).toBe(0);
    } finally {
      await closeServer(host);
    }
  });

  it('does not unlink a replacement path when the bound socket closes', async () => {
    const replacementBackup = `${socketPath}.bound-${process.pid}`;
    rmSync(replacementBackup, { force: true });
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: () => undefined,
      resolveRunContext: () => undefined,
      registerApprovalWait: async () => WAIT,
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    try {
      const bound = lstatSync(socketPath);
      renameSync(socketPath, replacementBackup);
      writeFileSync(socketPath, 'replacement-must-survive', { mode: 0o600 });
      await new Promise<void>((resolve) => host.close(() => resolve()));

      const replacement = lstatSync(socketPath);
      expect(replacement.isFile()).toBe(true);
      expect(`${replacement.dev}:${replacement.ino}`).not.toBe(`${bound.dev}:${bound.ino}`);
      expect(readFileSync(socketPath, 'utf8')).toBe('replacement-must-survive');
    } finally {
      if (host.listening) {
        await new Promise<void>((resolve) => host.close(() => resolve()));
      }
      rmSync(socketPath, { force: true });
      rmSync(replacementBackup, { force: true });
    }
  });

  it('does not clobber an existing Unix socket at startup', async () => {
    rmSync(socketPath, { force: true });
    const existing = createServer();
    existing.listen(socketPath);
    await waitForListening(existing);
    const identity = lstatSync(socketPath);
    let unexpected: Server | undefined;
    try {
      expect(() => {
        unexpected = startApprovalWorkflowHost({
          socketPath,
          consumeGrant: () => undefined,
          resolveRunContext: () => undefined,
          registerApprovalWait: async () => WAIT,
          verifyPeer: async () => true,
        });
      }).toThrow('host_path_invalid');
      const after = lstatSync(socketPath);
      expect(`${after.dev}:${after.ino}`).toBe(`${identity.dev}:${identity.ino}`);
    } finally {
      if (unexpected?.listening) {
        await new Promise<void>((resolve) => unexpected?.close(() => resolve()));
      }
      await new Promise<void>((resolve) => existing.close(() => resolve()));
      rmSync(socketPath, { force: true });
    }
  });

  it('preserves a replacement socket and tolerates an already absent path on shutdown', async () => {
    const backup = `${socketPath}.original-${process.pid}`;
    rmSync(backup, { force: true });
    const host = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: () => undefined,
      resolveRunContext: () => undefined,
      registerApprovalWait: async () => WAIT,
      verifyPeer: async () => true,
    });
    await waitForListening(host);
    renameSync(socketPath, backup);
    const replacement = createServer();
    replacement.listen(socketPath);
    await waitForListening(replacement);
    const replacementIdentity = lstatSync(socketPath);
    try {
      await new Promise<void>((resolve) => host.close(() => resolve()));
      const after = lstatSync(socketPath);
      expect(after.isSocket()).toBe(true);
      expect(`${after.dev}:${after.ino}`).toBe(`${replacementIdentity.dev}:${replacementIdentity.ino}`);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
      rmSync(socketPath, { force: true });
      rmSync(backup, { force: true });
    }

    const absentHost = startApprovalWorkflowHost({
      socketPath,
      consumeGrant: () => undefined,
      resolveRunContext: () => undefined,
      registerApprovalWait: async () => WAIT,
      verifyPeer: async () => true,
    });
    await waitForListening(absentHost);
    rmSync(socketPath, { force: true });
    await expect(new Promise<void>((resolve) => absentHost.close(() => resolve()))).resolves.toBeUndefined();
  });
});

async function sendApprovalWorkflowRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return sendRawApprovalWorkflowRequest(`${JSON.stringify(payload)}\n`);
}

async function sendRawApprovalWorkflowRequest(payload: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('host response timeout'));
    }, 1_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.end(payload);
    });
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(new Error('invalid host output'));
      }
    });
    socket.on('close', () => clearTimeout(timer));
  });
}

function waitForListening(server: { once: (event: string, listener: () => void) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
  });
}

async function closeServer(server: { close: (callback: () => void) => void }): Promise<void> {
  await new Promise<void>((resolve) => server.close(resolve));
  rmSync(socketPath, { force: true });
}
