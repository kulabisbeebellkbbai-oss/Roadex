import { createServer, type Server, type Socket } from 'node:net';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  ApprovalSessionCapability,
  RegisterApprovalWaitInput,
  RegisterApprovalWaitResult,
} from './approvalCoordinator.js';
import {
  APPROVAL_WORKFLOW_SOCKET,
} from './runnerCapabilityProfile.js';
import { verifyLinuxPeerCredentials } from './controlledOperationsPeer.js';
import type { ApprovalWorkflowGrant } from './approvalWorkflowGrantBroker.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 4_096;
const REQUEST_KEYS = ['approvalRef', 'provider', 'token'];
const APPROVAL_REFERENCE_PATTERN = /^(admin|roadex-human-decision)\.[A-Za-z0-9._:-]{1,220}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,16000}$/;

export type ApprovalWorkflowHostDependencies = {
  consumeGrant: (token: string) => ApprovalWorkflowGrant | undefined;
  resolveRunContext: (runId: string) => ApprovalSessionCapability | undefined;
  registerApprovalWait: (
    capability: ApprovalSessionCapability,
    input: RegisterApprovalWaitInput,
  ) => Promise<RegisterApprovalWaitResult>;
  verifyPeer?: (socket: Socket) => Promise<boolean>;
};

type ApprovalWorkflowRequest = {
  token: string;
  provider: 'overseer';
  approvalRef: string;
};

type ApprovalWorkflowResponse = {
  ok: boolean;
  waitId?: string;
  waitState?: string;
  reason?: string;
};

export function startApprovalWorkflowHost(
  dependencies: ApprovalWorkflowHostDependencies,
): Server {
  const verifyPeer = dependencies.verifyPeer ?? verifyLinuxPeerCredentials;
  prepareSocketPath(APPROVAL_WORKFLOW_SOCKET);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = Buffer.alloc(0);
    let completed = false;
    let peerAllowed = false;
    const deny = (reason: string): void => {
      if (completed) return;
      completed = true;
      socket.end(`${JSON.stringify({ ok: false, reason }).slice(0, MAX_RESPONSE_BYTES)}\n`);
    };
    const timer = setTimeout(() => {
      deny('request_timeout');
      socket.destroy();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();

    const processInput = (): void => {
      if (completed || !peerAllowed || socket.destroyed) return;
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== input.length - 1) {
        deny('request_invalid');
        return;
      }
      let request: ApprovalWorkflowRequest;
      try {
        request = parseRequest(input.subarray(0, newline).toString('utf8'));
      } catch {
        deny('request_invalid');
        return;
      }
      completed = true;
      clearTimeout(timer);
      void executeRequest(request)
        .then((response) => {
          socket.end(`${JSON.stringify(response).slice(0, MAX_RESPONSE_BYTES)}\n`);
        })
        .catch(() => {
          deny('workflow_request_failed');
        });
    };

    const executeRequest = async (request: ApprovalWorkflowRequest): Promise<ApprovalWorkflowResponse> => {
      const grant = dependencies.consumeGrant(request.token);
      if (!grant) return { ok: false, reason: 'grant_denied' };
      const run = dependencies.resolveRunContext(grant.runId);
      if (
        !run
        || run.userId !== grant.userId
        || run.sessionId !== grant.sessionId
        || run.workspaceId !== grant.workspaceId
        || run.managedThreadId !== grant.managedThreadId
      ) {
        return { ok: false, reason: 'scope_mismatch' };
      }
      const coordinatorResult = await dependencies.registerApprovalWait(run, {
        provider: request.provider,
        approvalRef: request.approvalRef,
      });
      return publicResult(coordinatorResult);
    };

    void verifyPeer(socket)
      .then((allowed) => {
        if (!allowed) {
          deny('peer_denied');
          return;
        }
        peerAllowed = true;
        socket.resume();
        processInput();
      })
      .catch(() => deny('peer_denied'));

    socket.on('data', (chunk) => {
      if (completed) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        deny('request_too_large');
        return;
      }
      processInput();
    });
    socket.once('close', () => clearTimeout(timer));
    socket.once('error', () => clearTimeout(timer));
  });
  server.once('listening', () => {
    chmodSync(APPROVAL_WORKFLOW_SOCKET, 0o600);
    const socketStat = lstatSync(APPROVAL_WORKFLOW_SOCKET);
    if (
      !socketStat.isSocket()
      || socketStat.uid !== process.getuid?.()
      || (socketStat.mode & 0o077) !== 0
    ) {
      server.close();
    }
  });
  server.listen(APPROVAL_WORKFLOW_SOCKET);
  server.once('close', () => rmSync(APPROVAL_WORKFLOW_SOCKET, { force: true }));
  return server;
}

function parseRequest(value: string): ApprovalWorkflowRequest {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== REQUEST_KEYS.join(',')) throw new Error('request_invalid');
  if (typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)) throw new Error('request_invalid');
  if (parsed.provider !== 'overseer') throw new Error('request_invalid');
  if (
    typeof parsed.approvalRef !== 'string'
    || !APPROVAL_REFERENCE_PATTERN.test(parsed.approvalRef)
  ) throw new Error('request_invalid');
  return parsed as ApprovalWorkflowRequest;
}

function publicResult(result: RegisterApprovalWaitResult): ApprovalWorkflowResponse {
  if (
    !result
    || typeof result !== 'object'
    || result.ok !== true
    || typeof result.wait.waitId !== 'string'
    || !['pending', 'verification-delayed', 'security-failure', 'approved-resume-queued', 'resume-dispatching', 'resume-reconciliation-required'].includes(result.wait.state)
  ) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  return {
    ok: true,
    waitId: result.wait.waitId,
    waitState: result.wait.state,
  };
}

function prepareSocketPath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error('host_path_invalid');
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.()
    || (stat.mode & 0o077) !== 0
    || realpathSync(parent) !== parent
  ) {
    throw new Error('host_path_invalid');
  }
  try {
    const existing = lstatSync(path);
    if (!existing.isSocket() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()) {
      throw new Error('host_path_invalid');
    }
    if ((existing.mode & 0o077) !== 0) {
      throw new Error('host_path_invalid');
    }
    if (existing.isSocket() && existing.uid === process.getuid?.()) {
      rmSync(path);
      return;
    }
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    throw new Error('host_path_invalid');
  }
}
