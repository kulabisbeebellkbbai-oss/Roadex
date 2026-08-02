import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  APPROVAL_WORKFLOW_SOCKET,
  APPROVAL_WORKFLOW_TOKEN_DIRECTORY,
} from './runnerCapabilityProfile.js';

const BROKER_RESPONSE_TIMEOUT_MS = 15 * 60 * 1_000;
const BROKER_MAX_BYTES = 4_096;

type BrokerRequest = {
  token: string;
  provider: 'overseer';
  approvalRef: string;
};

type BrokerResult = {
  ok: boolean;
  waitId?: string;
  waitState?: string;
  reason?: string;
};

function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export const APPROVAL_WORKFLOW_TOOLS = ['await_human_approval'] as const;
const APPROVAL_REFERENCE_PATTERN = /^(admin|roadex-human-decision)\.[A-Za-z0-9._:-]{1,220}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,16000}$/;

export function createApprovalWorkflowMcpServer(
  execute: (request: BrokerRequest) => Promise<BrokerResult> = executeBrokerRequest,
): McpServer {
  const server = new McpServer({
    name: 'roadex-workflow',
    version: '0.1.0',
  });
  server.registerTool('await_human_approval', {
    description: 'Pause this exact Roadex managed thread for one existing authoritative human approval. This tool cannot grant approval.',
    inputSchema: {
      provider: z.literal('overseer'),
      approvalRef: z.string().regex(APPROVAL_REFERENCE_PATTERN),
    },
  }, async ({ provider, approvalRef }) => jsonContent(await execute({
    token: requiredToken(),
    provider,
    approvalRef,
  })));
  return server;
}

export async function executeBrokerRequest(request: BrokerRequest): Promise<BrokerResult> {
  const socketPath = process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET ?? APPROVAL_WORKFLOW_SOCKET;
  if (!socketPath || socketPath !== APPROVAL_WORKFLOW_SOCKET) {
    throw new Error('Approval workflow broker is unavailable.');
  }
  return new Promise<BrokerResult>((resolveResult, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Approval workflow broker timed out.'));
    }, BROKER_RESPONSE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > BROKER_MAX_BYTES) {
        socket.destroy();
        reject(new Error('Approval workflow broker response too large.'));
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Approval workflow broker is unavailable.'));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(output) as BrokerResult;
        resolveResult({
          ok: parsed.ok === true,
          ...(parsed.waitId ? { waitId: clean(parsed.waitId) } : {}),
          ...(parsed.waitState ? { waitState: clean(parsed.waitState) } : {}),
          ...(parsed.reason ? { reason: clean(parsed.reason) } : {}),
        });
      } catch {
        reject(new Error('Approval workflow broker returned invalid output.'));
      }
    });
  });
}

export function requiredToken(): string {
  const path = process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
  if (!path || !new RegExp(`^${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/[0-9a-f-]{36}$`).test(path)) {
    throw new Error('Approval workflow authorization is unavailable.');
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
    ) {
      throw new Error('authorization_invalid');
    }
    const token = readFileSync(descriptor, 'utf8');
    if (!TOKEN_PATTERN.test(token)) throw new Error('authorization_invalid');
    return token;
  } catch {
    throw new Error('Approval workflow authorization is unavailable.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (path) unlinkSync(path);
    } catch {
      // Fail closed above if the token could not be opened and validated.
    }
  }
}


function clean(value: string): string {
  return value.slice(0, 2_000);
}

async function main(): Promise<void> {
  const server = createApprovalWorkflowMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
