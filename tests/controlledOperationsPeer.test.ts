import { execFileSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyLinuxPeerCredentials } from '../src/server/controlledOperationsPeer';

describe('Linux controlled operation peer credentials', () => {
  it('uses SO_PEERCRED to accept the same uid and fails closed without the helper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-peer-'));
    const helper = join(root, 'peer-check');
    const socketPath = join(root, 'peer.sock');
    execFileSync('/usr/bin/cc', [
      '-O2', '-Wall', '-Wextra', '-Werror',
      '-o', helper,
      'native/roadex-controlled-peer-check.c',
    ]);
    const results: boolean[] = [];
    let resolveChecked!: () => void;
    const checked = new Promise<void>((resolve) => { resolveChecked = resolve; });
    const server = createServer(async (socket) => {
      results.push(await verifyLinuxPeerCredentials(socket, helper, currentUnit()));
      results.push(await verifyLinuxPeerCredentials(socket, join(root, 'missing')));
      results.push(await verifyLinuxPeerCredentials(socket, helper, 'roadex.service'));
      socket.destroy();
      resolveChecked();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = createConnection(socketPath);
    await checked;
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(results).toEqual([true, false, false]);
  }, 10_000);
});

function currentUnit(): string {
  const line = execFileSync('/usr/bin/grep', ['^0::', '/proc/self/cgroup'], { encoding: 'utf8' }).trim();
  const unit = line.split('/').at(-1);
  if (!unit) throw new Error('test unit unavailable');
  return unit;
}
