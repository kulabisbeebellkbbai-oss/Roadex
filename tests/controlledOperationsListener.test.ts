import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startControlledOperationsListener,
} from '../src/server/controlledOperationsListener';
import { verifyLinuxPeerCredentials } from '../src/server/controlledOperationsPeer';

const servers: Array<ReturnType<typeof startControlledOperationsListener>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('controlled operations listener', () => {
  it('is default-off', () => {
    expect(() => startControlledOperationsListener({
      enabled: false,
      socketPath: join(mkdtempSync(join(tmpdir(), 'roadex-listener-')), 'broker.sock'),
      verifyPeer: async () => true,
      execute: async () => ({ ok: true }),
    })).toThrow('listener_disabled');
  });

  it('uses a private socket and accepts one exact authenticated request', async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'roadex-listener-')), 'broker.sock');
    const server = startControlledOperationsListener({
      enabled: true,
      socketPath,
      verifyPeer: async () => true,
      execute: async (request) => ({ ok: true, status: 'completed', summary: request.tool }),
    });
    servers.push(server);
    await listening(server);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await request(socketPath, {
      token: 'a'.repeat(40),
      tool: 'install_and_verify_workspace',
    });
    expect(response).toMatchObject({ ok: true, status: 'completed' });
  });

  it('returns a delayed operation result after the client half-closes its request', async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'roadex-listener-')), 'broker.sock');
    const server = startControlledOperationsListener({
      enabled: true,
      socketPath,
      requestTimeoutMs: 10,
      verifyPeer: async () => true,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: false, status: 'failed', reason: 'operation_failed' };
      },
    });
    servers.push(server);
    await listening(server);
    await expect(request(socketPath, {
      token: 'a'.repeat(40),
      tool: 'install_and_verify_workspace',
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'operation_failed',
    });
  });

  it('rejects before execution when peer verification fails or schema has extras', async () => {
    let executions = 0;
    const socketPath = join(mkdtempSync(join(tmpdir(), 'roadex-listener-')), 'broker.sock');
    const server = startControlledOperationsListener({
      enabled: true,
      socketPath,
      verifyPeer: async () => false,
      execute: async () => {
        executions += 1;
        return { ok: true };
      },
    });
    servers.push(server);
    await listening(server);
    expect(await request(socketPath, {
      token: 'a'.repeat(40),
      tool: 'install_and_verify_workspace',
      extra: true,
    })).toMatchObject({ ok: false, reason: 'peer_denied' });
    expect(executions).toBe(0);
  });

  it('continues reading after a real SO_PEERCRED helper check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-listener-peer-'));
    const helper = join(root, 'peer-check');
    const socketPath = join(root, 'broker.sock');
    execFileSync('/usr/bin/cc', [
      '-O2', '-Wall', '-Wextra', '-Werror',
      '-o', helper,
      'native/roadex-controlled-peer-check.c',
    ]);
    const server = startControlledOperationsListener({
      enabled: true,
      socketPath,
      verifyPeer: (socket) => verifyLinuxPeerCredentials(socket, helper, currentUnit()),
      execute: async () => ({ ok: true, status: 'completed' }),
    });
    servers.push(server);
    await listening(server);
    await expect(request(socketPath, {
      token: 'a'.repeat(40),
      tool: 'install_and_verify_workspace',
    })).resolves.toMatchObject({ ok: true, status: 'completed' });
  });
});

function listening(server: ReturnType<typeof startControlledOperationsListener>): Promise<void> {
  if (server.listening) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => server.once('listening', resolve));
}

function currentUnit(): string {
  const line = execFileSync('/usr/bin/grep', ['^0::', '/proc/self/cgroup'], { encoding: 'utf8' }).trim();
  const unit = line.split('/').at(-1);
  if (!unit) throw new Error('test unit unavailable');
  return unit;
}

function request(socketPath: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${JSON.stringify(body)}\n`));
    socket.on('data', (chunk) => { output += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(JSON.parse(output) as Record<string, unknown>));
  });
}
