import { appendAudit, type AuditLog } from './auditLog.js';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { DeviceBridgePolicy } from '../shared/deviceBridgeContracts.js';

const disabledReason = 'Client device bridge implementation is disabled pending separate exposure and hardware approvals.';

export function getDeviceBridgePolicy(): DeviceBridgePolicy {
  return {
    state: 'disabled',
    approvedFoundation: true,
    operations: ['esp32.flash'],
    reason: disabledReason,
  };
}

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
  const reason = disabledReason;
  appendAudit(log, user, 'security.denied', 'device-bridge', 'denied', reason);
  return {
    ok: false,
    gate: 'device-bridge',
    reason,
  };
}
