import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const OVERSEER_PROJECT = '/home/god/.local/share/overseer/project';
export const OVERSEER_STORE = `${OVERSEER_PROJECT}/state/overseer.sqlite3`;
export const OVERSEER_PYTHON = '/usr/bin/python3';
export const OVERSEER_ALLOWED_TOOLS = [
  'service_status',
  'remote_testing_status',
  'record_crew_message',
] as const;

type OverseerToolResult = Record<string, unknown>;

function jsonContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export function runOverseerCli(args: string[]): OverseerToolResult {
  const result = spawnSync(
    OVERSEER_PYTHON,
    ['-m', 'overseer.cli', ...args],
    {
      encoding: 'utf8',
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? 'C.UTF-8',
        PATH: process.env.PATH,
        PYTHONPATH: `${OVERSEER_PROJECT}/src`,
      },
      maxBuffer: 1_048_576,
      timeout: 15_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Overseer coordination command failed.');
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid output');
    }
    return parsed as OverseerToolResult;
  } catch {
    throw new Error('Overseer coordination returned invalid output.');
  }
}

export function createOverseerMcpServer(
  execute: (args: string[]) => OverseerToolResult = runOverseerCli,
): McpServer {
  const server = new McpServer({
    name: 'roadex-controlled-overseer',
    version: '0.1.0',
  });

  server.registerTool(
    'service_status',
    {
      description: 'Read the current redacted Overseer service status from its fixed local store.',
      inputSchema: {},
    },
    async () => jsonContent(execute(['service-status', '--store', OVERSEER_STORE])),
  );

  server.registerTool(
    'remote_testing_status',
    {
      description: 'Read the redacted Tank/MSI remote-testing queue and adapter status.',
      inputSchema: {},
    },
    async () => jsonContent(execute([
      'remote-testing-status',
      '--project-root',
      OVERSEER_PROJECT,
    ])),
  );

  server.registerTool(
    'record_crew_message',
    {
      description: 'Record a bounded coordination request for one approved Overseer crew domain.',
      inputSchema: {
        ownerDomain: z.enum([
          'sisko', 'kira', 'obrien', 'odo', 'odo_ids', 'odo_firewall',
          'quark', 'dax', 'julian', 'ezri',
        ]),
        subject: z.string().trim().min(1).max(120),
        message: z.string().trim().min(1).max(2_000),
        priority: z.enum(['low', 'medium', 'high']).default('medium'),
      },
    },
    async ({ ownerDomain, subject, message, priority }) => jsonContent(execute([
      'record-crew-message',
      '--store',
      OVERSEER_STORE,
      '--owner-domain',
      ownerDomain,
      '--subject',
      subject,
      '--message',
      message,
      '--priority',
      priority,
      '--requested-by',
      'Roadex-controlled-runner',
      '--related-resource-id',
      'roadex.controlled-runner',
    ])),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createOverseerMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
