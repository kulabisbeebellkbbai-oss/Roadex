import { appendAudit, type AuditLog } from './auditLog.js';
import type { UserProfile } from '../shared/sessionContracts.js';

export type DeviceBridgeDecision =
  | {
      ok: true;
    }
  | {
      ok: false;
      gate: 'device-bridge';
      reason: string;
    };

export function denyDeviceBridge(log: AuditLog, user: UserProfile): DeviceBridgeDecision {
  const reason = 'Client device bridge is disabled until the core portal passes security review.';
  appendAudit(log, user, 'security.denied', 'device-bridge', 'denied', reason);
  return {
    ok: false,
    gate: 'device-bridge',
    reason,
  };
}
