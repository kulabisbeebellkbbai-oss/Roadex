import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  chmodSync,
  rmSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const tokenDirectory = vi.hoisted(() => `/tmp/roadex-approval-workflow-tokens-${process.pid}`);

const brokerResponses: Array<{
  payload: string;
  onRequest: (request: unknown) => void;
}> = [];
const connectionPaths: string[] = [];

vi.mock('node:net', () => {
  return {
    createConnection: (socketPath: string) => {
      connectionPaths.push(socketPath);
      const socket = new EventEmitter() as MockClientSocket;
      socket.setEncoding = () => {};
      socket.end = (payload?: string) => {
        const response = brokerResponses.shift();
        if (!response) {
          socket.emit('error', new Error('broker_response_missing'));
          return;
        }
        let request: unknown = undefined;
        if (typeof payload === 'string') {
          try {
            request = JSON.parse(payload);
          } catch {
            request = payload;
          }
        }
        response.onRequest(request);
        socket.emit('data', response.payload);
        socket.emit('end');
      };
      socket.destroy = () => {
        socket.emit('close');
      };
      process.nextTick(() => socket.emit('connect'));
      return socket;
    },
  };
});

vi.mock('../src/server/runnerCapabilityProfile', async () => {
  const actual = await vi.importActual<typeof import('../src/server/runnerCapabilityProfile')>(
    '../src/server/runnerCapabilityProfile',
  );
  return {
    ...actual,
    APPROVAL_WORKFLOW_TOKEN_DIRECTORY: tokenDirectory,
  };
});

import {
  APPROVAL_WORKFLOW_SOCKET,
} from '../src/server/runnerCapabilityProfile';
import {
  createApprovalWorkflowMcpServer,
  executeBrokerRequest,
  resetApprovalWorkflowTokenCacheForTests,
} from '../src/server/approvalWorkflowMcp';

type MockClientSocket = {
  setEncoding: () => void;
  end: (payload?: string) => void;
  destroy: () => void;
  on: (...args: Parameters<EventEmitter['on']>) => void;
  emit: (...args: Parameters<EventEmitter['emit']>) => void;
};

function queueBrokerResponse(payload: string, onRequest: (request: unknown) => void = () => {}): void {
  brokerResponses.push({ payload, onRequest });
}

function clearBrokerState(): void {
  brokerResponses.length = 0;
  connectionPaths.length = 0;
}

function createApprovalWorkflowTokenFile(token: string): string {
  if (!/^[A-Za-z0-9_-]{20,16000}$/.test(token)) throw new Error('approval_workflow_token_invalid');
  const path = join(tokenDirectory, randomUUID());
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, token, { encoding: 'utf8' });
    fstatSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

beforeEach(() => {
  clearBrokerState();
  resetApprovalWorkflowTokenCacheForTests();
  process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET = APPROVAL_WORKFLOW_SOCKET;
  mkdirSync(tokenDirectory, { recursive: true });
});

afterEach(() => {
  if (typeof process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE === 'string'
    && process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE.startsWith(tokenDirectory)
  ) {
    rmSync(process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE, { force: true });
  }
  delete process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
  delete process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET;
  clearBrokerState();
  resetApprovalWorkflowTokenCacheForTests();
  for (const entry of readdirSync(tokenDirectory)) {
    rmSync(join(tokenDirectory, entry), { force: true });
  }
});

describe('approval workflow MCP adapter', () => {
  it('exposes only await_human_approval', async () => {
    const { client, close } = await connectedClient();
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['await_human_approval']);
      const failure = await client.callTool({ name: 'install_and_verify_workspace', arguments: {} });
      expect(failure.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('passes bounded input to broker and redacts oversized result fields', async () => {
    const tokenFile = createApprovalWorkflowTokenFile('a'.repeat(40));
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;
    const requests: unknown[] = [];

    queueBrokerResponse(JSON.stringify({
      ok: true,
      wait: {
        waitId: 'w'.repeat(8_000),
        approvalRef: 'admin.workflow.approved',
        state: 'pending',
        updatedAt: new Date().toISOString(),
        subject: 'approval',
        consoleSurface: 'admin',
        consolePath: '/approval/path',
      },
    }), (request) => {
      requests.push(request);
    });

    const { client, close } = await connectedClient();
    try {
      const response = await client.callTool({
        name: 'await_human_approval',
        arguments: {
          provider: 'overseer',
          approvalRef: 'admin.workflow.approved',
        },
      });
      expect(response.isError).not.toBe(true);
      expect(requests).toEqual([{
        token: 'a'.repeat(40),
        provider: 'overseer',
        approvalRef: 'admin.workflow.approved',
      }]);
      const payload = JSON.parse(response.content[0]?.text ?? '{}') as { ok: true; wait: { waitId: string } };
      expect(payload.ok).toBe(true);
      expect(payload.wait.waitId).toHaveLength(2000);
      expect(response.content[0]?.text).not.toContain('a'.repeat(40));
      expect(connectionPaths[0]).toBe(APPROVAL_WORKFLOW_SOCKET);
      expect(existsSync(tokenFile)).toBe(false);
    } finally {
      await close();
    }
  });

  it('reads and unlinks one-time token files across MCP tool calls', async () => {
    const tokenFile = createApprovalWorkflowTokenFile('b'.repeat(40));
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;

    queueBrokerResponse(JSON.stringify({
      ok: true,
      wait: {
        waitId: 'w-1',
        approvalRef: 'admin.workflow.approved',
        state: 'pending',
        updatedAt: new Date().toISOString(),
        subject: 'approval',
        consoleSurface: 'admin',
      },
    }), () => {});

    const { client, close } = await connectedClient();

    try {
      const response = await client.callTool({
        name: 'await_human_approval',
        arguments: {
          provider: 'overseer',
          approvalRef: 'admin.workflow.approved',
        },
      });
      expect(response.isError).not.toBe(true);
      const payload = JSON.parse(response.content[0]?.text ?? '{}') as { ok: true; wait: { waitId: string } };
      expect(payload).toMatchObject({ ok: true, wait: { waitId: 'w-1' } });
      expect(existsSync(tokenFile)).toBe(false);

      const secondResponse = await client.callTool({
        name: 'await_human_approval',
        arguments: {
          provider: 'overseer',
          approvalRef: 'admin.workflow.approved',
        },
      });
      expect(secondResponse.isError).toBe(true);
      expect(secondResponse.content[0]?.text).not.toContain('b'.repeat(40));
    } finally {
      await close();
    }
  });

  it('fails once when token cleanup fails and does not reread without reset', async () => {
    const firstTokenFile = createApprovalWorkflowTokenFile('e'.repeat(40));
    const secondTokenFile = createApprovalWorkflowTokenFile('f'.repeat(40));

    const { client, close } = await connectedClient();
    try {
      process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = firstTokenFile;
      chmodSync(tokenDirectory, 0o500);
      const firstResponse = await client.callTool({
        name: 'await_human_approval',
        arguments: {
          provider: 'overseer',
          approvalRef: 'admin.workflow.approved',
        },
      });
      expect(firstResponse.isError).toBe(true);
      expect(firstResponse.content[0]?.text).not.toContain('e'.repeat(40));
      expect(firstResponse.content[0]?.text).not.toContain(firstTokenFile);
      expect(connectionPaths).toHaveLength(0);
      expect(existsSync(firstTokenFile)).toBe(true);

      chmodSync(tokenDirectory, 0o700);
      process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = secondTokenFile;
      const secondResponse = await client.callTool({
        name: 'await_human_approval',
        arguments: {
          provider: 'overseer',
          approvalRef: 'admin.workflow.approved',
        },
      });
      expect(secondResponse.isError).toBe(true);
      expect(secondResponse.content[0]?.text).not.toContain('f'.repeat(40));
      expect(secondResponse.content[0]?.text).not.toContain(secondTokenFile);
      expect(connectionPaths).toHaveLength(0);
      expect(existsSync(secondTokenFile)).toBe(true);

      resetApprovalWorkflowTokenCacheForTests();
      queueBrokerResponse(JSON.stringify({
        ok: true,
        wait: {
          waitId: 'w-2',
          approvalRef: 'admin.workflow.approved',
          state: 'pending',
          updatedAt: new Date().toISOString(),
          subject: 'approval',
          consoleSurface: 'admin',
        },
      }));

      const thirdResponse = await client.callTool({
        name: 'await_human_approval',
        arguments: {
          provider: 'overseer',
          approvalRef: 'admin.workflow.approved',
        },
      });
      expect(thirdResponse.isError).not.toBe(true);
      expect(connectionPaths).toHaveLength(1);
      expect(existsSync(secondTokenFile)).toBe(false);
    } finally {
      chmodSync(tokenDirectory, 0o700);
      await close();
    }
  });

  it('rejects malformed token files and fixed socket inputs', async () => {
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = 'not-a-token-path';

    const { client, close } = await connectedClient();
    const badTokenResponse = await client.callTool({
      name: 'await_human_approval',
      arguments: {
        provider: 'overseer',
        approvalRef: 'admin.workflow.approved',
      },
    });
    expect(badTokenResponse.isError).toBe(true);
    expect(badTokenResponse.content[0]?.text).not.toContain('not-a-token-path');
    await close();

    const tokenFile = createApprovalWorkflowTokenFile('c'.repeat(40));
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;
    process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET = '/tmp/not-workflow-socket';
    expect(existsSync(tokenFile)).toBe(true);
    await expect(executeBrokerRequest({
      token: 'placeholder',
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })).rejects.toThrow('Roadex workflow broker is unavailable.');
    expect(existsSync(tokenFile)).toBe(true);

    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = `${tokenDirectory}/11111111-1111-1111-1111-111111111111`;
    const malformedResponse = await connectedClient();
    const malformedTokenResponse = await malformedResponse.client.callTool({
      name: 'await_human_approval',
      arguments: {
        provider: 'overseer',
        approvalRef: 'admin.workflow.approved',
      },
    });
    expect(malformedTokenResponse.isError).toBe(true);
    expect(malformedTokenResponse.content[0]?.text).not.toContain('11111111-1111-1111-1111-111111111111');
    await malformedResponse.close();
  });

  it('rejects malformed broker responses', async () => {
    const tokenFile = createApprovalWorkflowTokenFile('d'.repeat(40));
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;
    queueBrokerResponse('{"oops":1}', () => {});
    await expect(executeBrokerRequest({
      token: 'placeholder',
      provider: 'overseer',
      approvalRef: 'admin.workflow.approved',
    })).rejects.toThrow('Roadex workflow broker returned invalid output.');
  });
});

async function connectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createApprovalWorkflowMcpServer();
  const client = new Client({ name: 'approval-workflow-test', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
