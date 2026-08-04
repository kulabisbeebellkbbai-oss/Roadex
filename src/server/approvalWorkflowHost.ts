import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  ApprovalSessionCapability,
  RegisterApprovalWaitInput,
  RegisterApprovalWaitResult,
} from './approvalCoordinator.js';
import {
  type ApprovalStageLocator,
  type ApprovalTypedIntent,
  isTypedApprovalIntent,
} from './approvalWorkflowMcp.js';
import {
  APPROVAL_WORKFLOW_SOCKET,
} from './runnerCapabilityProfile.js';
import { verifyLinuxPeerCredentials } from './controlledOperationsPeer.js';
import type { ApprovalWorkflowGrant } from './approvalWorkflowGrantBroker.js';
import { isApprovalWorkflowToken } from './approvalWorkflowGrantBroker.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 4_096;
const REQUEST_KEYS = ['intent', 'provider', 'token'];
const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCOPE_FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WAIT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
type SocketIdentity = { dev: number; ino: number };

export type ApprovalWorkflowHostDependencies = {
  consumeGrant: (token: string) => ApprovalWorkflowGrant | undefined;
  resolveRunContext: (runId: string) => ApprovalSessionCapability | undefined;
  stageTypedIntent?: (
    capability: ApprovalSessionCapability,
    intent: ApprovalTypedIntent,
  ) => Promise<ApprovalStageLocator>;
  registerApprovalWait: (
    capability: ApprovalSessionCapability,
    input: RegisterApprovalWaitInput,
  ) => Promise<RegisterApprovalWaitResult>;
  socketPath?: string;
  verifyPeer?: (socket: Socket) => Promise<boolean>;
  requestTimeoutMs?: number;
};

type ApprovalWorkflowRequest = {
  token: string;
  provider: 'overseer';
  intent: ApprovalTypedIntent;
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
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const socketPath = dependencies.socketPath ?? APPROVAL_WORKFLOW_SOCKET;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > REQUEST_TIMEOUT_MS) {
    throw new Error('host_timeout_invalid');
  }
  prepareSocketPath(socketPath);
  let boundIdentity: SocketIdentity | undefined;
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
    let input = Buffer.alloc(0);
    let processing = false;
    let responded = false;
    let peerAllowed = false;
    let inputEnded = false;
    const respond = (response: ApprovalWorkflowResponse): void => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);
      const encoded = JSON.stringify(response);
      const bounded = Buffer.byteLength(encoded) <= MAX_RESPONSE_BYTES
        ? encoded
        : JSON.stringify({ ok: false, reason: 'response_invalid' });
      socket.resume();
      socket.end(`${bounded}\n`);
    };
    const deny = (reason: string): void => {
      respond({ ok: false, reason });
    };
    const timer = setTimeout(() => {
      deny('request_timeout');
    }, requestTimeoutMs);
    timer.unref();

    const processInput = (): void => {
      if (processing || responded || !peerAllowed || !inputEnded || socket.destroyed) return;
      const newline = input.indexOf(0x0a);
      if (newline < 0 || newline !== input.length - 1) {
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
      processing = true;
      void executeRequest(request)
        .then((response) => {
          respond(response);
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
      let locator: ApprovalStageLocator;
      try {
        if (!dependencies.stageTypedIntent) return { ok: false, reason: 'workflow_request_failed' };
        locator = await dependencies.stageTypedIntent(run, request.intent);
      } catch {
        return { ok: false, reason: 'workflow_request_failed' };
      }
      if (!isExactApprovalStageLocator(locator) || !locatorMatchesRun(locator, run)) {
        return { ok: false, reason: 'scope_mismatch' };
      }
      const coordinatorResult = await dependencies.registerApprovalWait(run, {
        provider: locator.provider,
        approvalRef: locator.approvalRef,
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
      if (processing || responded) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        deny('request_too_large');
        return;
      }
      processInput();
    });
    socket.once('end', () => {
      inputEnded = true;
      processInput();
    });
    socket.once('close', () => clearTimeout(timer));
    socket.once('error', () => clearTimeout(timer));
  });
  server.once('listening', () => {
    chmodSync(socketPath, 0o600);
    const socketStat = lstatSync(socketPath);
    boundIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    if (
      !socketStat.isSocket()
      || socketStat.uid !== process.getuid?.()
      || (socketStat.mode & 0o077) !== 0
    ) {
      server.close();
      return;
    }
  });
  installReplacementSafeClose(server, socketPath, () => boundIdentity);
  server.listen(socketPath);
  return server;
}

function parseRequest(value: string): ApprovalWorkflowRequest {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== REQUEST_KEYS.join(',')) throw new Error('request_invalid');
  if (!isApprovalWorkflowToken(parsed.token)) throw new Error('request_invalid');
  if (parsed.provider !== 'overseer') throw new Error('request_invalid');
  if (!isTypedApprovalIntent(parsed.intent)) throw new Error('request_invalid');
  return parsed as ApprovalWorkflowRequest;
}

function isExactApprovalStageLocator(value: unknown): value is ApprovalStageLocator {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [
    'approvalRef', 'authorityClass', 'projectId', 'provider', 'resourceRef', 'scopeDigest', 'workspaceId',
  ].join(',')) return false;
  return (
    record.provider === 'overseer'
    && typeof record.approvalRef === 'string'
    && APPROVAL_REFERENCE_PATTERN.test(record.approvalRef)
    && typeof record.projectId === 'string'
    && SCOPE_FIELD_PATTERN.test(record.projectId)
    && typeof record.workspaceId === 'string'
    && SCOPE_FIELD_PATTERN.test(record.workspaceId)
    && typeof record.resourceRef === 'string'
    && SCOPE_FIELD_PATTERN.test(record.resourceRef)
    && (record.authorityClass === 'privileged-operation' || record.authorityClass === 'project-workflow')
    && typeof record.scopeDigest === 'string'
    && SHA256_PATTERN.test(record.scopeDigest)
  );
}

function locatorMatchesRun(locator: ApprovalStageLocator, run: ApprovalSessionCapability): boolean {
  return (
    locator.projectId === run.projectId
    && locator.workspaceId === run.workspaceId
    && locator.resourceRef === run.resourceRef
  );
}

function publicResult(result: RegisterApprovalWaitResult): ApprovalWorkflowResponse {
  if (
    !result
    || typeof result !== 'object'
    || result.ok !== true
    || typeof result.wait.waitId !== 'string'
    || !WAIT_ID_PATTERN.test(result.wait.waitId)
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
    throw new Error('host_path_invalid');
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

function installReplacementSafeClose(
  server: Server,
  socketPath: string,
  getBoundIdentity: () => SocketIdentity | undefined,
): void {
  const nativeClose = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void): Server => {
    const held = holdReplacementDuringClose(socketPath, getBoundIdentity());
    return nativeClose((error?: Error) => {
      let restoreError: Error | undefined;
      try {
        held?.restore();
      } catch {
        restoreError = new Error('host_path_invalid');
      }
      callback?.(restoreError ?? error);
    });
  }) as Server['close'];
}

function holdReplacementDuringClose(
  path: string,
  boundIdentity: SocketIdentity | undefined,
): { restore: () => void } | undefined {
  let current;
  try {
    current = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error('host_path_invalid');
  }
  if (
    boundIdentity
    && current.isSocket()
    && current.dev === boundIdentity.dev
    && current.ino === boundIdentity.ino
  ) {
    return undefined;
  }

  const heldPath = `${path}.shutdown-${randomBytes(16).toString('hex')}`;
  renameSync(path, heldPath);
  const heldIdentity = lstatSync(heldPath);
  return {
    restore: () => {
      const stillHeld = lstatSync(heldPath);
      if (stillHeld.dev !== heldIdentity.dev || stillHeld.ino !== heldIdentity.ino) {
        throw new Error('host_path_invalid');
      }
      try {
        lstatSync(path);
        return;
      } catch (error) {
        if (!isMissing(error)) throw new Error('host_path_invalid');
      }
      renameSync(heldPath, path);
    },
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
