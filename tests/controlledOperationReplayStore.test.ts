import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlledOperationError } from '../src/server/controlledOperations';
import { DurableControlledOperationReplayStore } from '../src/server/controlledOperationReplayStore';

describe('durable controlled operation replay store', () => {
  it('atomically preserves one-time consumption across instances', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-replay-'));
    const nonce = '12345678-1234-1234-1234-123456789abc';
    expect(new DurableControlledOperationReplayStore(root).consume(nonce)).toBe(true);
    expect(new DurableControlledOperationReplayStore(root).consume(nonce)).toBe(false);
  });

  it('fails closed on unexpected records and symlink roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadex-replay-'));
    writeFileSync(join(root, 'unexpected'), '');
    expect(() => new DurableControlledOperationReplayStore(root).consume(
      '12345678-1234-1234-1234-123456789abc',
    )).toThrowError(new ControlledOperationError('replay_store_invalid'));

    const parent = mkdtempSync(join(tmpdir(), 'roadex-replay-parent-'));
    const target = mkdtempSync(join(tmpdir(), 'roadex-replay-target-'));
    const link = join(parent, 'link');
    symlinkSync(target, link);
    expect(() => new DurableControlledOperationReplayStore(link)).toThrowError(
      new ControlledOperationError('replay_store_invalid'),
    );
  });
});
