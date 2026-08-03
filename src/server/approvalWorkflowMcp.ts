import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  closeSync,
  fstatSync,
  lstatSync,
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
import { isApprovalWorkflowToken } from './approvalWorkflowGrantBroker.js';

const BROKER_RESPONSE_TIMEOUT_MS = 15 * 60 * 1_000;
const BROKER_MAX_BYTES = 4_096;
const WAIT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const WAIT_STATES = new Set([
  'pending',
  'verification-delayed',
  'security-failure',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
]);
const BROKER_DENIAL_REASONS = new Set([
  'grant_denied',
  'scope_mismatch',
  'request_invalid',
  'request_too_large',
  'peer_denied',
  'request_timeout',
  'workflow_request_failed',
  'response_invalid',
]);

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
  const socketPath = process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET;
  if (
    socketPath !== APPROVAL_WORKFLOW_SOCKET
    || !isApprovalWorkflowToken(request.token)
    || request.provider !== 'overseer'
    || !APPROVAL_REFERENCE_PATTERN.test(request.approvalRef)
  ) {
    throw new Error('Approval workflow broker is unavailable.');
  }
  const boundedRequest: BrokerRequest = {
    token: request.token,
    provider: 'overseer',
    approvalRef: request.approvalRef,
  };
  return new Promise<BrokerResult>((resolveResult, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Approval workflow broker timed out.'));
    }, BROKER_RESPONSE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.end(`${JSON.stringify(boundedRequest)}\n`);
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
        resolveResult(parseBrokerResult(output));
      } catch {
        reject(new Error('Approval workflow broker returned invalid output.'));
      }
    });
  });
}

export type ApprovalWorkflowTokenFileOperations = {
  lstat?: typeof lstatSync;
  unlink?: typeof unlinkSync;
};

export function requiredToken(operations: ApprovalWorkflowTokenFileOperations = {}): string {
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
    ) {
      throw new Error('authorization_invalid');
    }
    const token = stat.size === 43 ? readFileSync(descriptor, 'utf8') : undefined;
    const pathStat = (operations.lstat ?? lstatSync)(path);
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.uid !== stat.uid
      || pathStat.dev !== stat.dev
      || pathStat.ino !== stat.ino
      || (pathStat.mode & 0o077) !== 0
    ) {
      throw new Error('authorization_invalid');
    }
    (operations.unlink ?? unlinkSync)(path);
    if (!isApprovalWorkflowToken(token)) throw new Error('authorization_invalid');
    return token;
  } catch {
    throw new Error('Approval workflow authorization is unavailable.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseBrokerResult(output: string): BrokerResult {
  const newline = output.indexOf('\n');
  if (newline < 0 || newline !== output.length - 1 || output.indexOf('\n', newline + 1) >= 0) {
    throw new Error('broker_output_invalid');
  }
  const parsed = JSON.parse(output.slice(0, newline)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('broker_output_invalid');
  }
  const keys = Object.keys(parsed).sort();
  if (
    parsed.ok === true
    && keys.join(',') === 'ok,waitId,waitState'
    && typeof parsed.waitId === 'string'
    && WAIT_ID_PATTERN.test(parsed.waitId)
    && typeof parsed.waitState === 'string'
    && WAIT_STATES.has(parsed.waitState)
  ) {
    return { ok: true, waitId: parsed.waitId, waitState: parsed.waitState };
  }
  if (
    parsed.ok === false
    && keys.join(',') === 'ok,reason'
    && typeof parsed.reason === 'string'
    && BROKER_DENIAL_REASONS.has(parsed.reason)
  ) {
    return { ok: false, reason: parsed.reason };
  }
  throw new Error('broker_output_invalid');
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
