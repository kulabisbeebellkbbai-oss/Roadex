import { createConnection } from 'node:net';
import { closeSync, fstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  APPROVAL_WORKFLOW_SOCKET,
  APPROVAL_WORKFLOW_TOKEN_DIRECTORY,
} from './runnerCapabilityProfile.js';
import { type WaitingApprovalSummary } from '../shared/approvalWorkflowContracts.js';

const BROKER_RESPONSE_TIMEOUT_MS = 15 * 60 * 1_000;
const BROKER_RESULT_FIELD_MAX_LENGTH = 2_000;
const UUID_V4_BASENAME = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export const APPROVAL_WORKFLOW_TOOL = ['await_human_approval'] as const;

type BrokerRequest = {
  token: string;
  provider: 'overseer';
  approvalRef: string;
};

type BrokerErrorCode =
  | 'peer_denied'
  | 'request_invalid'
  | 'token_denied'
  | 'run_not_active'
  | 'scope_mismatch'
  | 'request_timeout'
  | 'approval_not_pending'
  | 'provider_unavailable'
  | 'active_wait_exists'
  | 'registration_failed';

type BrokerResult = {
  ok: true;
  wait: {
    waitId: string;
    approvalRef: string;
    state: WaitingApprovalSummary['state'];
    updatedAt: string;
    subject: string;
    consoleSurface: WaitingApprovalSummary['consoleSurface'];
    consolePath?: string;
  };
} | {
  ok: false;
  code: BrokerErrorCode;
};

function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createApprovalWorkflowMcpServer(
  execute: (request: BrokerRequest) => Promise<BrokerResult> = executeBrokerRequest,
): McpServer {
  const server = new McpServer({
    name: 'roadex-workflow',
    version: '0.1.0',
  });

  server.registerTool(
    'await_human_approval',
    {
      description: 'Pause this exact Roadex managed thread for one existing authoritative human approval. This tool cannot grant approval.',
      inputSchema: {
        provider: z.literal('overseer'),
        approvalRef: z.string().regex(/^(admin|roadex-human-decision)\.[A-Za-z0-9._:-]{1,220}$/),
      },
    },
    async ({ provider, approvalRef }) => jsonContent(await execute({
      token: requiredToken(),
      provider,
      approvalRef,
    })),
  );

  return server;
}

export async function executeBrokerRequest(request: BrokerRequest): Promise<BrokerResult> {
  const socketPath = process.env.ROADEX_APPROVAL_WORKFLOW_SOCKET ?? APPROVAL_WORKFLOW_SOCKET;
  if (socketPath !== APPROVAL_WORKFLOW_SOCKET) throw new Error('Roadex workflow broker is unavailable.');
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Roadex workflow broker timed out.'));
    }, BROKER_RESPONSE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 64_000) {
        socket.destroy(new Error('response_too_large'));
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Roadex workflow broker is unavailable.'));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = parseBrokerResult(output);
        resolveResult(parsed);
      } catch {
        reject(new Error('Roadex workflow broker returned invalid output.'));
      }
    });
  });
}

function parseBrokerResult(value: string): BrokerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('invalid');
  }

  if (!isRecord(parsed)) throw new Error('invalid');

  const root: Record<string, unknown> = parsed;
  if (root.ok !== true && root.ok !== false) throw new Error('invalid');

  if (root.ok) {
    if (!root.wait || !isRecord(root.wait)) throw new Error('invalid');
    const wait = root.wait;

    if (Object.keys(wait).length < 5) {
      throw new Error('invalid');
    }
    const allowedWaitKeys = ['approvalRef', 'consolePath', 'consoleSurface', 'state', 'subject', 'updatedAt', 'waitId'];
    for (const key of Object.keys(wait)) {
      if (!allowedWaitKeys.includes(key)) {
        throw new Error('invalid');
      }
    }
    if (
      typeof wait.waitId !== 'string'
      || typeof wait.approvalRef !== 'string'
      || typeof wait.state !== 'string'
      || !isApprovalState(wait.state)
      || typeof wait.updatedAt !== 'string'
      || typeof wait.subject !== 'string'
      || wait.subject.length === 0
      || typeof wait.consoleSurface !== 'string'
      || (wait.consoleSurface !== 'admin' && wait.consoleSurface !== 'overview')
    ) {
      throw new Error('invalid');
    }

    return {
      ok: true,
      wait: {
        waitId: clean(wait.waitId),
        approvalRef: clean(wait.approvalRef),
        state: wait.state,
        updatedAt: clean(wait.updatedAt),
        subject: clean(wait.subject),
        consoleSurface: wait.consoleSurface,
        consolePath: typeof wait.consolePath === 'string' ? clean(wait.consolePath) : undefined,
      },
    };
  }

  if (Object.keys(root).length !== 2 || root.code === undefined) {
    throw new Error('invalid');
  }

  if (typeof root.code !== 'string' || !isKnownErrorCode(root.code)) {
    throw new Error('invalid');
  }

  return {
    ok: false,
    code: root.code,
  };
}

let cachedToken: string | undefined;
let tokenReadAttempted = false;

function requiredToken(): string {
  if (cachedToken) return cachedToken;
  if (tokenReadAttempted) {
    throw new Error('Roadex approval workflow authorization is unavailable.');
  }
  tokenReadAttempted = true;
  const path = process.env.ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE;
  if (
    !path
    || !new RegExp(`^${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/${UUID_V4_BASENAME}$`).test(path)
  ) throw new Error('Roadex approval workflow authorization is unavailable.');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600
      || stat.size < 20
      || stat.size > 16_000
    ) throw new Error('invalid');
    const token = readFileSync(descriptor, 'utf8');
    if (!/^[A-Za-z0-9_-]{20,16000}$/.test(token)) throw new Error('invalid');
    closeSync(descriptor);
    descriptor = undefined;
    unlinkSync(path);
    cachedToken = token;
    return token;
  } catch {
    throw new Error('Roadex approval workflow authorization is unavailable.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function resetApprovalWorkflowTokenCacheForTests(): void {
  cachedToken = undefined;
  tokenReadAttempted = false;
}

function clean(value: string): string {
  return value.slice(0, BROKER_RESULT_FIELD_MAX_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function isKnownErrorCode(value: string): value is BrokerErrorCode {
  return value === 'peer_denied'
    || value === 'request_invalid'
    || value === 'token_denied'
    || value === 'run_not_active'
    || value === 'scope_mismatch'
    || value === 'request_timeout'
    || value === 'approval_not_pending'
    || value === 'provider_unavailable'
    || value === 'active_wait_exists'
    || value === 'registration_failed';
}

function isApprovalState(value: string): value is WaitingApprovalSummary['state'] {
  return value === 'pending'
    || value === 'verification-delayed'
    || value === 'security-failure'
    || value === 'approved-resume-queued'
    || value === 'resume-dispatching'
    || value === 'resume-reconciliation-required';
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
