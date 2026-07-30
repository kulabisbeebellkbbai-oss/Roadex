import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { closeSync, fstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sanitizeControlledOperationResult } from './controlledOperations.js';
import { CONTROLLED_OPERATIONS_SOCKET } from './runnerCapabilityProfile.js';
import { CONTROLLED_OPERATION_TOKEN_DIRECTORY } from './runnerCapabilityProfile.js';

const BROKER_RESPONSE_TIMEOUT_MS = 15 * 60 * 1_000;

export const CONTROLLED_OPERATION_TOOLS = [
  'install_and_verify_workspace',
  'publish_git_changes',
] as const;

type BrokerRequest = {
  token: string;
  tool: typeof CONTROLLED_OPERATION_TOOLS[number];
  commitMessage?: string;
};

type BrokerResult = {
  ok: boolean;
  operationId?: string;
  status?: string;
  summary?: string;
  reason?: string;
};

function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createControlledOperationsMcpServer(
  execute: (request: BrokerRequest) => Promise<BrokerResult> = executeBrokerRequest,
): McpServer {
  const server = new McpServer({
    name: 'roadex-controlled-operations',
    version: '0.1.0',
  });

  server.registerTool(
    'install_and_verify_workspace',
    {
      description: 'Consume an exact owner-authorized grant to install pinned npm dependencies and run the fixed isolated verification suite.',
      inputSchema: {},
    },
    async () => jsonContent(await execute({
      token: requiredToken(),
      tool: 'install_and_verify_workspace',
    })),
  );

  server.registerTool(
    'publish_git_changes',
    {
      description: 'Consume an exact owner-authorized grant to audit, commit, and optionally push the bound Git snapshot.',
      inputSchema: {
        commitMessage: z.string().trim().min(1).max(72).refine((value) => !/[\r\n\0]/.test(value)),
      },
    },
    async ({ commitMessage }) => jsonContent(await execute({
      token: requiredToken(),
      tool: 'publish_git_changes',
      commitMessage,
    })),
  );

  return server;
}

export async function executeBrokerRequest(request: BrokerRequest): Promise<BrokerResult> {
  const socketPath = process.env.ROADEX_CONTROLLED_OPERATION_SOCKET ?? CONTROLLED_OPERATIONS_SOCKET;
  if (socketPath !== CONTROLLED_OPERATIONS_SOCKET) throw new Error('Controlled operation broker is unavailable.');
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Controlled operation broker timed out.'));
    }, BROKER_RESPONSE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 64_000) socket.destroy(new Error('response_too_large'));
    });
    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Controlled operation broker is unavailable.'));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(output) as BrokerResult;
        resolveResult({
          ok: parsed.ok === true,
          operationId: clean(parsed.operationId),
          status: clean(parsed.status),
          summary: clean(parsed.summary),
          reason: clean(parsed.reason),
        });
      } catch {
        reject(new Error('Controlled operation broker returned invalid output.'));
      }
    });
  });
}

let cachedToken: string | undefined;

function requiredToken(): string {
  if (cachedToken) return cachedToken;
  const path = process.env.ROADEX_CONTROLLED_OPERATION_TOKEN_FILE;
  if (!path || !new RegExp(`^${CONTROLLED_OPERATION_TOKEN_DIRECTORY}/[0-9a-f-]{36}$`).test(path)) {
    throw new Error('Controlled operation authorization is unavailable.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.uid !== process.getuid?.()
      || (stat.mode & 0o077) !== 0
      || stat.size < 20
      || stat.size > 16_000
    ) throw new Error('invalid');
    const token = readFileSync(descriptor, 'utf8');
    if (!/^[A-Za-z0-9_-]{20,16000}$/.test(token)) throw new Error('invalid');
    cachedToken = token;
    return token;
  } catch {
    throw new Error('Controlled operation authorization is unavailable.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch {
      // Fail closed above if the token could not be opened and validated.
    }
  }
}

export function resetControlledOperationTokenCacheForTests(): void {
  cachedToken = undefined;
}

function clean(value: string | undefined): string | undefined {
  return value ? sanitizeControlledOperationResult(value).slice(0, 2_000) : undefined;
}

async function main(): Promise<void> {
  const server = createControlledOperationsMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
