import { createServer, type Server, type Socket } from 'node:net';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  type ApprovalSessionCapability,
  type RegisterApprovalWaitInput,
  type RegisterApprovalWaitResult,
} from './approvalCoordinator.js';
import { type WaitingApprovalSummary } from '../shared/approvalWorkflowContracts.js';
import { ApprovalWorkflowGrantBroker } from './approvalWorkflowGrantBroker.js';

export const APPROVAL_WORKFLOW_SOCKET = '/run/user/1000/roadex-approval-workflow.sock';

const MAX_REQUEST_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 15_000;
const WAIT_FIELD_MAX_LENGTH = 2_000;

export type ApprovalWorkflowSocketRequest = {
  token: string;
  provider: 'overseer';
  approvalRef: string;
};

export type ApprovalWorkflowSocketResult = {
  ok: true;
  wait: WaitingApprovalSummary;
} | {
  ok: false;
  code:
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
};

type RegisterApprovalWaitErrorResult = Exclude<RegisterApprovalWaitResult, { ok: true }>;
type MappedRegistrationErrorCode = Exclude<ApprovalWorkflowSocketResult, { ok: true }>['code'];

export type ApprovalWorkflowHostOptions = {
  enabled: boolean;
  socketPath: string;
  verifyPeer: (socket: Socket) => Promise<boolean>;
  resolveRunCapability: (
    runId: string,
  ) => Promise<ApprovalSessionCapability | undefined> | ApprovalSessionCapability | undefined;
  register: (
    capability: ApprovalSessionCapability,
    input: RegisterApprovalWaitInput,
  ) => Promise<RegisterApprovalWaitResult>;
  broker: ApprovalWorkflowGrantBroker;
};

export function startApprovalWorkflowHost(options: ApprovalWorkflowHostOptions): Server {
  if (!options.enabled) throw new Error('approval_workflow_host_disabled');
  if (options.socketPath !== APPROVAL_WORKFLOW_SOCKET) throw new Error('host_path_invalid');
  requireAbsoluteSocketPath(options.socketPath);
  prepareSocketParent(options.socketPath);

  let shutdownSocketPath: string | undefined;

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = Buffer.alloc(0);
    let completed = false;
    let peerVerified = false;
    let readEnded = false;
    let completing = false;
    const finish = (result: ApprovalWorkflowSocketResult): void => {
      if (completed) return;
      completed = true;
      completing = false;
      clearTimeout(timer);
      socket.end(`${JSON.stringify(result)}\n`);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, code: 'request_timeout' });
      socket.destroy();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();

    const complete = async () => {
      if (completed || completing || !peerVerified || !readEnded || socket.destroyed) return;
      completing = true;

      const newline = input.indexOf(0x0a);
      if (newline < 0 || newline !== input.length - 1) {
        finish({ ok: false, code: 'request_invalid' });
        return;
      }

      try {
        const request = parseRequest(input.subarray(0, newline).toString('utf8'));
        try {
          finish(await executeRequest(request, options));
        } catch {
          finish({ ok: false, code: 'registration_failed' });
        }
      } catch {
        finish({ ok: false, code: 'request_invalid' });
      }
      completing = false;
    };

    void options.verifyPeer(socket).then((allowed) => {
      if (!allowed) {
        finish({ ok: false, code: 'peer_denied' });
        return;
      }
      peerVerified = true;
      socket.resume();
      void complete();
    }).catch(() => finish({ ok: false, code: 'peer_denied' }));

    socket.on('data', (chunk) => {
      if (completed) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        finish({ ok: false, code: 'request_invalid' });
        return;
      }
      void complete();
    });

    socket.on('end', () => {
      if (completed) return;
      readEnded = true;
      void complete();
    });

    socket.once('close', () => clearTimeout(timer));
    socket.once('error', () => clearTimeout(timer));
  });

  server.once('listening', () => {
    chmodSync(options.socketPath, 0o600);
    const socketStat = lstatSync(options.socketPath);
    if (
      !socketStat.isSocket()
      || socketStat.uid !== process.getuid?.()
      || (socketStat.mode & 0o777) !== 0o600
    ) {
      server.close();
      return;
    }
    shutdownSocketPath = options.socketPath;
  });
  server.listen(options.socketPath);
  server.once('close', () => {
    if (shutdownSocketPath === undefined) return;
    rmSync(shutdownSocketPath, { force: true });
  });

  return server;
}

async function executeRequest(
  request: ApprovalWorkflowSocketRequest,
  options: ApprovalWorkflowHostOptions,
): Promise<ApprovalWorkflowSocketResult> {
  const grant = options.broker.consume(request.token);
  if (!grant) {
    return { ok: false, code: 'token_denied' };
  }

  const capability = await options.resolveRunCapability(grant.runId);
  if (!capability) {
    return { ok: false, code: 'run_not_active' };
  }

  if (
    capability.userId !== grant.userId
    || capability.workspaceId !== grant.workspaceId
    || capability.managedThreadId !== grant.managedThreadId
    || capability.sessionId !== grant.sessionId
  ) {
    return { ok: false, code: 'scope_mismatch' };
  }

  const result = await options.register(capability, {
    provider: request.provider,
    approvalRef: request.approvalRef,
  });
  if (!result.ok) {
    return { ok: false, code: mapCoordinatorCode(result.code) };
  }

  const wait = normalizeWait(result.wait);
  if (!wait) {
    return { ok: false, code: 'registration_failed' };
  }

  return { ok: true, wait };
}

function mapCoordinatorCode(code: RegisterApprovalWaitErrorResult['code']): MappedRegistrationErrorCode {
  if (code === 'scope-mismatch') return 'scope_mismatch';
  if (code === 'approval-not-pending') return 'approval_not_pending';
  if (code === 'provider-unavailable') return 'provider_unavailable';
  if (code === 'active-wait-exists') return 'active_wait_exists';
  return 'registration_failed';
}

function normalizeWait(wait: WaitingApprovalSummary): WaitingApprovalSummary | undefined {
  if (!isObject(wait)) return undefined;
  if (!isExactString(wait.waitId)) return undefined;
  if (!isExactString(wait.approvalRef)) return undefined;
  if (!isSafeSummaryState(wait.state)) return undefined;
  if (!isExactString(wait.updatedAt)) return undefined;
  if (wait.consoleSurface !== 'admin' && wait.consoleSurface !== 'overview') return undefined;
  if (!isExactString(wait.subject)) return undefined;

  return {
    waitId: limitField(wait.waitId),
    approvalRef: limitField(wait.approvalRef),
    subject: limitField(wait.subject),
    consoleSurface: wait.consoleSurface,
    consolePath: typeof wait.consolePath === 'string' ? limitField(wait.consolePath) : undefined,
    state: wait.state,
    updatedAt: limitField(wait.updatedAt),
  };
}

function isSafeSummaryState(value: string): value is WaitingApprovalSummary['state'] {
  return value === 'pending'
    || value === 'verification-delayed'
    || value === 'security-failure'
    || value === 'approved-resume-queued'
    || value === 'resume-dispatching'
    || value === 'resume-reconciliation-required';
}

function limitField(value: string): string {
  return value.slice(0, WAIT_FIELD_MAX_LENGTH);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function isExactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseRequest(value: string): ApprovalWorkflowSocketRequest {
  const parsed = JSON.parse(value);
  if (!isObject(parsed)) throw new Error('request_invalid');
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== ['approvalRef', 'provider', 'token'].sort().join(',')) {
    throw new Error('request_invalid');
  }
  if (
    typeof parsed.token !== 'string'
    || !/^[A-Za-z0-9_-]{20,16000}$/.test(parsed.token)
    || parsed.provider !== 'overseer'
    || typeof parsed.approvalRef !== 'string'
    || !/^(admin|roadex-human-decision)\.[A-Za-z0-9._:-]{1,220}$/.test(parsed.approvalRef)
  ) {
    throw new Error('request_invalid');
  }
  return parsed as ApprovalWorkflowSocketRequest;
}

function prepareSocketParent(socketPath: string): void {
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.uid !== process.getuid?.()
    || (parentStat.mode & 0o077) !== 0
    || realpathSync(parent) !== parent
  ) {
    throw new Error('host_path_invalid');
  }

  try {
    const existing = lstatSync(socketPath);
    if (
      !existing.isSocket()
      || existing.isSymbolicLink()
      || existing.uid !== process.getuid?.()
      || (existing.mode & 0o777) !== 0o600
    ) {
      throw new Error('host_path_invalid');
    }
    rmSync(socketPath, { force: true });
  } catch (error) {
    if (
      error && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) return;
    if (error instanceof Error && error.message === 'host_path_invalid') {
      throw error;
    }
    throw error;
  }
}

function requireAbsoluteSocketPath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error('host_path_invalid');
  }
}
