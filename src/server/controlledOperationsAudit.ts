import { createHmac } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import {
  ControlledOperationError,
  type ControlledOperationGrant,
} from './controlledOperations.js';
import type { ControlledBrokerResult } from './controlledOperationsBroker.js';

export class ControlledOperationsAuditWriter {
  constructor(
    private readonly path: string,
    private readonly hmacKey: string,
    private readonly write: typeof writeSync = writeSync,
  ) {
    if (!path.startsWith('/') || path.includes('\0') || Buffer.byteLength(hmacKey) < 32) {
      throw new ControlledOperationError('audit_configuration_invalid');
    }
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new ControlledOperationError('audit_configuration_invalid');
    }
  }

  append(
    grant: ControlledOperationGrant,
    result: ControlledBrokerResult,
    phase: 'accepted' | 'terminal' = 'terminal',
  ): void {
    const event = {
      at: new Date().toISOString(),
      action: 'controlled_operation.result',
      phase,
      actorTag: this.tag(`user:${grant.userId}`),
      sessionTag: this.tag(`session:${grant.sessionId}`),
      workspaceTag: this.tag(`workspace:${grant.workspaceId}`),
      operationTag: this.tag(`operation:${grant.operationId}`),
      intent: grant.intent,
      outcome: result.ok ? 'allowed' : 'denied',
      status: result.status ?? 'denied',
      reason: result.reason ?? null,
    };
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        this.path,
        fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new ControlledOperationError('audit_write_failed');
      }
      const record = Buffer.from(`${JSON.stringify(event)}\n`);
      let offset = 0;
      while (offset < record.length) {
        const written = this.write(descriptor, record, offset, record.length - offset);
        if (!Number.isInteger(written) || written <= 0) {
          throw new ControlledOperationError('audit_write_failed');
        }
        offset += written;
      }
      fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof ControlledOperationError) throw error;
      throw new ControlledOperationError('audit_write_failed');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private tag(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex').slice(0, 32);
  }
}
