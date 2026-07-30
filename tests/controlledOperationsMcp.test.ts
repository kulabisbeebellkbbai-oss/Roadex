import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CONTROLLED_OPERATION_TOOLS,
  createControlledOperationsMcpServer,
  resetControlledOperationTokenCacheForTests,
} from '../src/server/controlledOperationsMcp';
import { createControlledOperationTokenFile } from '../src/server/codexRunner';

describe('controlled operations MCP adapter', () => {
  it('exposes only install verification and Git publication tools', async () => {
    const { client, close } = await connectedClient(async () => ({ ok: true }));
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        [...CONTROLLED_OPERATION_TOOLS].sort(),
      );
    } finally {
      await close();
    }
  });

  it('passes only bounded tool input to the broker', async () => {
    resetControlledOperationTokenCacheForTests();
    const original = process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE;
    process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE = createControlledOperationTokenFile('a'.repeat(40));
    const calls: unknown[] = [];
    const { client, close } = await connectedClient(async (request) => {
      calls.push(request);
      return { ok: true, operationId: 'controlled-operation-1', status: 'completed' };
    });
    try {
      await client.callTool({
        name: 'publish_git_changes',
        arguments: { commitMessage: 'Add fixture milestone' },
      });
      expect(calls).toEqual([{
        token: 'a'.repeat(40),
        tool: 'publish_git_changes',
        commitMessage: 'Add fixture milestone',
      }]);
    } finally {
      if (original === undefined) delete process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE;
      else process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE = original;
      resetControlledOperationTokenCacheForTests();
      await close();
    }
  });

  it('rejects arbitrary tools and multiline commit messages', async () => {
    resetControlledOperationTokenCacheForTests();
    const original = process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE;
    process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE = createControlledOperationTokenFile('b'.repeat(40));
    const calls: unknown[] = [];
    const { client, close } = await connectedClient(async (request) => {
      calls.push(request);
      return { ok: true };
    });
    try {
      expect((await client.callTool({ name: 'execute_shell', arguments: {} })).isError).toBe(true);
      expect((await client.callTool({
        name: 'publish_git_changes',
        arguments: { commitMessage: 'good\nbad' },
      })).isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE;
      else process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE = original;
      resetControlledOperationTokenCacheForTests();
      await close();
    }
  });
});

async function connectedClient(
  execute: Parameters<typeof createControlledOperationsMcpServer>[0],
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlledOperationsMcpServer(execute);
  const client = new Client({ name: 'controlled-operations-test', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
