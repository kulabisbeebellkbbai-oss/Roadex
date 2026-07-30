import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';

export const CONTROLLED_PEER_CHECK_EXECUTABLE =
  '/home/god/.local/libexec/roadex-controlled-peer-check';
export const CONTROLLED_PEER_SYSTEMD_UNIT = 'roadex.service';

export function verifyLinuxPeerCredentials(
  socket: Socket,
  executable = CONTROLLED_PEER_CHECK_EXECUTABLE,
  expectedUnit = CONTROLLED_PEER_SYSTEMD_UNIT,
): Promise<boolean> {
  if (
    socket.destroyed
    || !socket.readable
    || !socket.writable
    || !/^[A-Za-z0-9_.@-]{1,128}\.(?:service|scope)$/.test(expectedUnit)
  ) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (allowed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(allowed && !socket.destroyed);
    };
    const child = spawn(executable, [expectedUnit], {
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', socket],
    });
    child.once('error', () => finish(false));
    child.once('close', (code, signal) => finish(code === 0 && signal === null));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 2_000);
    timer.unref();
  });
}
