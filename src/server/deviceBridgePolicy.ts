import { appendAudit, type AuditLog } from './auditLog.js';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { DeviceBridgePolicy } from '../shared/deviceBridgeContracts.js';

const disabledReason = 'Client device bridge implementation is disabled pending separate exposure and hardware approvals.';
const inventoryJsonEnv = 'ROADEX_DEVICE_BRIDGE_INVENTORY_JSON';
const requestIntakeEnabledEnv = 'ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED';
const auditHmacKeyEnv = 'ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY';

export type DeviceBridgeInventoryDevice = {
  projectId: string;
  id: string;
};

export function getDeviceBridgePolicy(): DeviceBridgePolicy {
  return {
    state: 'disabled',
    approvedFoundation: true,
    operations: ['esp32.flash'],
    requestIntakeEnabled: deviceBridgeRequestIntakeEnabled(),
    operationsEnabled: deviceBridgeOperationsEnabled(),
    reason: disabledReason,
  };
}

export function deviceBridgeRequestIntakeEnabled(): boolean {
  return strictEnabledByEnv(process.env[requestIntakeEnabledEnv]);
}

export function deviceBridgeOperationsEnabled(): false {
  return false;
}

export function deviceBridgeAuditHmacKey(): string | undefined {
  const key = process.env[auditHmacKeyEnv]?.trim();
  return key && key.length >= 32 ? key : undefined;
}

export function resolveDeviceBridgeInventoryDevice(
  projectId: string,
  deviceId: string,
): DeviceBridgeInventoryDevice | undefined {
  const raw = process.env[inventoryJsonEnv];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as DeviceBridgeInventoryDevice[];
    return parsed.find((device) => device.projectId === projectId && device.id === deviceId);
  } catch {
    return undefined;
  }
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

export function isAvailableDeviceBridgeIntakeRoute(method: string | undefined, pathname: string): boolean {
  return method === 'POST' && /^\/api\/sessions\/[^/]+\/device-bridge\/requests$/.test(pathname);
}

function strictEnabledByEnv(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  return false;
}
