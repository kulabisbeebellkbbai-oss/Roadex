import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createOverseerMcpServer,
  OVERSEER_ALLOWED_TOOLS,
  OVERSEER_PROJECT,
  OVERSEER_STORE,
} from '../src/server/overseerMcp';

describe('controlled Overseer MCP adapter', () => {
  it('exposes only the fixed coordination tool set', async () => {
    expect(OVERSEER_ALLOWED_TOOLS).toEqual([
      'service_status',
      'remote_testing_status',
      'record_crew_message',
      'get_crew_request',
      'list_crew_requests',
      'resubmit_crew_request',
    ]);
    const { client, close } = await connectedClient(() => ({ ok: true }));
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        [...OVERSEER_ALLOWED_TOOLS].sort(),
      );
    } finally {
      await close();
    }
  });

  it('uses fixed Overseer paths outside caller input', () => {
    expect(OVERSEER_PROJECT).toBe('/home/god/.local/share/overseer/project');
    expect(OVERSEER_STORE).toBe('/home/god/.local/share/overseer/project/state/overseer.sqlite3');
  });

  it('maps tool calls to fixed CLI commands and bounded crew input', async () => {
    const calls: string[][] = [];
    const { client, close } = await connectedClient((args) => {
      calls.push(args);
      return { ok: true };
    });
    try {
      await client.callTool({ name: 'service_status', arguments: {} });
      await client.callTool({ name: 'remote_testing_status', arguments: {} });
      await client.callTool({
        name: 'record_crew_message',
        arguments: {
          ownerDomain: 'quark',
          subject: 'Roadex smoke',
          message: 'Coordinate a bounded read-only test.',
          priority: 'high',
        },
      });
      expect(calls).toEqual([
        ['service-status', '--store', OVERSEER_STORE],
        ['remote-testing-status', '--project-root', OVERSEER_PROJECT],
        [
          'record-crew-message',
          '--store',
          OVERSEER_STORE,
          '--owner-domain',
          'quark',
          '--subject',
          'Roadex smoke',
          '--message',
          'Coordinate a bounded read-only test.',
          '--priority',
          'high',
          '--requested-by',
          'Roadex-controlled-runner',
        ],
      ]);
    } finally {
      await close();
    }
  });

  it('rejects unapproved tools and invalid crew input before execution', async () => {
    const calls: string[][] = [];
    const { client, close } = await connectedClient((args) => {
      calls.push(args);
      return { ok: true };
    });
    try {
      const unapproved = await client.callTool({ name: 'execute_admin_change', arguments: {} });
      expect(unapproved.isError).toBe(true);
      const invalid = await client.callTool({
        name: 'record_crew_message',
        arguments: {
          ownerDomain: 'admin',
          subject: 'x',
          message: 'y',
          priority: 'critical',
        },
      });
      expect(invalid.isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it('allows a Roadex correction to update bounded review linkage and evidence', async () => {
    const calls: string[][] = [];
    const { client, close } = await connectedClient((args) => { calls.push(args); return { ok: true }; });
    try {
      await client.callTool({ name: 'resubmit_crew_request', arguments: {
        messageId: 'crew.odo-ids.original',
        subject: 'Corrected IDS review',
        message: 'Review the linked staged plan.',
        relatedPlanId: 'admin.donuthole.route',
        acceptanceCriteria: ['accepted IDS advisory is linked'],
        evidenceIds: ['ids-review.admin.donuthole.route'],
      }});
      expect(calls[0]).toContain('--related-plan-id');
      expect(calls[0]).toContain('admin.donuthole.route');
      expect(calls[0].filter((item) => item === '--expected-requester')).toHaveLength(2);
    } finally {
      await close();
    }
  });
});

async function connectedClient(execute: (args: string[]) => Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createOverseerMcpServer(execute);
  const client = new Client({ name: 'overseer-mcp-test', version: '0.1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
