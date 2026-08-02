import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_WORKFLOW_TOOLS,
  createApprovalWorkflowMcpServer,
  executeBrokerRequest,
  requiredToken,
} from '../src/server/approvalWorkflowMcp';
import { createApprovalWorkflowTokenFile } from '../src/server/codexRunner';

describe('approval workflow MCP adapter', () => {
  it('exposes only await_human_approval', async () => {
    const { client, close } = await connectedClient();
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        [...APPROVAL_WORKFLOW_TOOLS].sort(),
      );
    } finally {
      await close();
    }
  });

  it('passes bounded tool input and performs one-time token read/unlink', async () => {
    const token = 'a'.repeat(40);
    const tokenFile = createApprovalWorkflowTokenFile(token);
    const original = process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;
    const calls: unknown[] = [];
    const { client, close } = await connectedClient(async (request) => {
      calls.push(request);
      return { ok: true, waitId: 'wait-1', waitState: 'pending' };
    });
    try {
      const response = await client.callTool({
        name: 'await_human_approval',
        arguments: { provider: 'overseer', approvalRef: 'admin.roadex.test' },
      });
      expect(JSON.parse(response.content[0]?.text ?? '{}')).toMatchObject({
        ok: true,
        waitId: 'wait-1',
        waitState: 'pending',
      });
      expect(calls).toEqual([{ token, provider: 'overseer', approvalRef: 'admin.roadex.test' }]);
      expect(() => readFileSync(tokenFile, 'utf8')).toThrow();
      const second = await client.callTool({
        name: 'await_human_approval',
        arguments: { provider: 'overseer', approvalRef: 'admin.roadex.test' },
      });
      expect(second.isError).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      if (original === undefined) {
        delete process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
      } else {
        process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = original;
      }
      await close();
    }
  });

  it('rejects arbitrary tools and malformed tool inputs', async () => {
    const tokenFile = createApprovalWorkflowTokenFile('b'.repeat(40));
    const original = process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;
    const calls: unknown[] = [];
    const { client, close } = await connectedClient(async (request) => {
      calls.push(request);
      return { ok: true, waitId: 'wait-1', waitState: 'pending' };
    });
    try {
      expect((await client.callTool({ name: 'publish_git_changes', arguments: {} })).isError).toBe(true);
      expect((await client.callTool({
        name: 'await_human_approval',
        arguments: { provider: 'overseer', approvalRef: 'bad token' },
      })).isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
      } else {
        process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = original;
      }
      await close();
    }
  });

  it('rejects non-fixed socket overrides and malformed token files', async () => {
    const originalSocket = process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET;
    const originalTokenFile = process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
    const token = 'c'.repeat(40);
    const tokenFile = createApprovalWorkflowTokenFile(token);
    let malformedToken: string | undefined;
    process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET = '/tmp/invalid-workflow-socket.sock';
    process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = tokenFile;
    const { client, close } = await connectedClient();
    try {
      const socketResponse = await client.callTool({
        name: 'await_human_approval',
        arguments: { provider: 'overseer', approvalRef: 'admin.roadex.test' },
      });
      expect(socketResponse.isError).toBe(true);
      const socketError = String(socketResponse.content[0]?.text ?? '');
      expect(socketError).toContain('unavailable');
      expect(socketError).not.toContain(token);
      malformedToken = createApprovalWorkflowTokenFile('d'.repeat(40));
      writeFileSync(malformedToken, 'not a valid token');
      process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = malformedToken;
      let malformedError: unknown;
      try {
        requiredToken();
      } catch (error) {
        malformedError = error;
      }
      expect(malformedError).toBeTruthy();
      expect(String(malformedError)).not.toContain('not a valid token');
    } finally {
      if (originalSocket === undefined) {
        delete process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET;
      } else {
        process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET = originalSocket;
      }
      if (originalTokenFile === undefined) {
        delete process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
      } else {
        process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE = originalTokenFile;
      }
      [tokenFile, malformedToken]
        .filter((path): path is string => Boolean(path))
        .forEach((path) => {
          try {
            unlinkSync(path);
          } catch {
            // Best effort cleanup.
          }
        });
      await close();
    }
  });
});

async function connectedClient(
  execute: Parameters<typeof createApprovalWorkflowMcpServer>[0] = executeBrokerRequest,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createApprovalWorkflowMcpServer(execute);
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
