import { createServer, type Socket } from 'node:net';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  ControlledOperationError,
  sanitizeControlledOperationResult,
} from './controlledOperations.js';
import type {
  ControlledBrokerRequest,
  ControlledBrokerResult,
} from './controlledOperationsBroker.js';

const MAX_REQUEST_BYTES = 64_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type ControlledOperationsListenerOptions = {
  enabled: boolean;
  socketPath: string;
  requestTimeoutMs?: number;
  verifyPeer: (socket: Socket) => Promise<boolean>;
  execute: (request: ControlledBrokerRequest) => Promise<ControlledBrokerResult>;
};

export function startControlledOperationsListener(options: ControlledOperationsListenerOptions) {
  if (!options.enabled) throw new ControlledOperationError('listener_disabled');
  requireAbsoluteSocketPath(options.socketPath);
  prepareSocketParent(options.socketPath);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = Buffer.alloc(0);
    let completed = false;
    let peerAllowed = false;
    const deny = (reason: string): void => {
      if (completed) return;
      completed = true;
      socket.end(`${JSON.stringify({ ok: false, status: 'denied', reason })}\n`);
    };
    const timer = setTimeout(() => {
      deny('request_timeout');
      socket.destroy();
    }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    timer.unref();
    const processInput = (): void => {
      if (completed || !peerAllowed || socket.destroyed) return;
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== input.length - 1) {
        deny('request_invalid');
        return;
      }
      let request: ControlledBrokerRequest;
      try {
        request = parseRequest(input.subarray(0, newline).toString('utf8'));
      } catch {
        deny('request_invalid');
        return;
      }
      completed = true;
      clearTimeout(timer);
      void options.execute(request).then((result) => {
        socket.end(`${JSON.stringify(publicResult(result))}\n`);
      }).catch(() => {
        socket.end(`${JSON.stringify({ ok: false, status: 'denied', reason: 'operation_denied' })}\n`);
      });
    };
    void options.verifyPeer(socket).then((allowed) => {
      if (!allowed) {
        deny('peer_denied');
        return;
      }
      peerAllowed = true;
      socket.resume();
      processInput();
    }).catch(() => deny('peer_denied'));
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
    chmodSync(options.socketPath, 0o600);
    const socketStat = lstatSync(options.socketPath);
    if (
      !socketStat.isSocket()
      || socketStat.uid !== process.getuid?.()
      || (socketStat.mode & 0o077) !== 0
    ) {
      server.close();
    }
  });
  server.listen(options.socketPath);
  server.once('close', () => rmSync(options.socketPath, { force: true }));
  return server;
}

function parseRequest(value: string): ControlledBrokerRequest {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  const allowed = parsed.tool === 'publish_git_changes'
    ? ['commitMessage', 'token', 'tool']
    : ['token', 'tool'];
  if (
    keys.join(',') !== allowed.sort().join(',')
    || typeof parsed.token !== 'string'
    || !/^[A-Za-z0-9_-]{20,16000}$/.test(parsed.token)
    || (parsed.tool !== 'install_and_verify_workspace' && parsed.tool !== 'publish_git_changes')
    || (parsed.tool === 'publish_git_changes'
      && (typeof parsed.commitMessage !== 'string' || !parsed.commitMessage.trim()))
  ) throw new ControlledOperationError('request_invalid');
  return parsed as ControlledBrokerRequest;
}

function publicResult(result: ControlledBrokerResult): ControlledBrokerResult {
  return {
    ok: result.ok === true,
    ...(result.operationId ? { operationId: clean(result.operationId) } : {}),
    ...(result.status ? { status: result.status } : {}),
    ...(result.summary ? { summary: clean(result.summary) } : {}),
    ...(result.reason ? { reason: clean(result.reason) } : {}),
  };
}

function clean(value: string): string {
  return sanitizeControlledOperationResult(value).slice(0, 2_000);
}

function prepareSocketParent(socketPath: string): void {
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.()
    || (stat.mode & 0o077) !== 0
    || realpathSync(parent) !== parent
  ) throw new ControlledOperationError('listener_path_invalid');
  try {
    const existing = lstatSync(socketPath);
    if (!existing.isSocket() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()) {
      throw new ControlledOperationError('listener_path_invalid');
    }
    rmSync(socketPath);
  } catch (error) {
    if (
      error instanceof ControlledOperationError
      || !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
    ) throw error;
  }
}

function requireAbsoluteSocketPath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new ControlledOperationError('listener_path_invalid');
  }
}
