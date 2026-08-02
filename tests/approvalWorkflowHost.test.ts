import { createConnection } from 'node:net';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';
import { startApprovalWorkflowHost } from '../src/server/approvalWorkflowHost';
import { APPROVAL_WORKFLOW_SOCKET } from '../src/server/runnerCapabilityProfile';
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

describe('approval workflow host listener', () => {
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
      consumeGrant: (token) => broker.consume(token),
      resolveRunContext: (runId) => runId === 'run-1' ? runContext : undefined,
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
        approvalRef: 'admin.roadex.test',
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
        approvalRef: 'admin.roadex.test',
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

      expect(await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        approvalRef: 'admin.roadex.test',
        extra: 'field',
      } as never)).toEqual({ ok: false, reason: 'request_invalid' });
      expect(consumed).toBe(0);

      expect(await sendApprovalWorkflowRequest({
        token: grant.token,
        provider: 'overseer',
        approvalRef: 'admin.roadex.test',
      })).toEqual({ ok: false, reason: 'scope_mismatch' });
      expect(consumed).toBe(1);
    } finally {
      await closeServer(host);
    }
  });
});

async function sendApprovalWorkflowRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(APPROVAL_WORKFLOW_SOCKET);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.end(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(new Error('invalid host output'));
      }
    });
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
  rmSync(APPROVAL_WORKFLOW_SOCKET, { force: true });
}
