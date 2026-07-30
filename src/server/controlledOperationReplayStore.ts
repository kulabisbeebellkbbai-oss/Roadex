import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROLLED_OPERATION_MAX_AGE_MS,
  ControlledOperationError,
  type ControlledOperationReplayStoreLike,
} from './controlledOperations.js';

const MAX_REPLAY_RECORDS = 10_000;

export class DurableControlledOperationReplayStore implements ControlledOperationReplayStoreLike {
  private readonly root: string;

  constructor(root: string, private readonly now: () => number = Date.now) {
    if (!root.startsWith('/') || root.includes('\0')) throw new ControlledOperationError('replay_store_invalid');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ControlledOperationError('replay_store_invalid');
    }
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new ControlledOperationError('replay_store_invalid');
    }
    this.root = realpathSync(root);
  }

  consume(nonce: string): boolean {
    if (!/^[0-9a-f-]{36}$/.test(nonce)) throw new ControlledOperationError('grant_invalid');
    this.pruneExpired();
    if (readdirSync(this.root).length >= MAX_REPLAY_RECORDS) {
      throw new ControlledOperationError('replay_store_full');
    }
    const path = join(this.root, nonce);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.uid !== process.getuid?.()) {
        throw new ControlledOperationError('replay_store_invalid');
      }
      fsyncSync(descriptor);
      const directory = openSync(this.root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return true;
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'EEXIST'
      ) return false;
      if (error instanceof ControlledOperationError) throw error;
      throw new ControlledOperationError('replay_store_invalid');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private pruneExpired(): void {
    const cutoff = this.now() - CONTROLLED_OPERATION_MAX_AGE_MS;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!/^[0-9a-f-]{36}$/.test(entry.name) || !entry.isFile()) {
        throw new ControlledOperationError('replay_store_invalid');
      }
      const path = join(this.root, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new ControlledOperationError('replay_store_invalid');
      }
      if (stat.mtimeMs < cutoff) rmSync(path);
    }
  }
}
