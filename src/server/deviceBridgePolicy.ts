import { appendAudit, type AuditLog } from './auditLog.js';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { DeviceBridgePolicy } from '../shared/deviceBridgeContracts.js';

const disabledReason = 'Client device bridge implementation is disabled pending separate exposure and hardware approvals.';
const inventoryJsonEnv = 'ROADEX_DEVICE_BRIDGE_INVENTORY_JSON';
const requestIntakeEnabledEnv = 'ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED';
const approvalEnabledEnv = 'ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED';
const descriptorObservationEnabledEnv = 'ROADEX_DEVICE_BRIDGE_DESCRIPTOR_OBSERVATION_ENABLED';
const descriptorHmacKeyEnv = 'ROADEX_DEVICE_BRIDGE_DESCRIPTOR_HMAC_KEY';
const metadataRegistryEnabledEnv = 'ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED';
const auditHmacKeyEnv = 'ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY';
const identityHmacKeyEnv = 'ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY';
const probeEnabledEnv = 'ROADEX_DEVICE_BRIDGE_PROBE_ENABLED';

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
    descriptorObservationEnabled: deviceBridgeDescriptorObservationEnabled(),
    operationsEnabled: deviceBridgeOperationsEnabled(),
    reason: disabledReason,
  };
}

export function deviceBridgeRequestIntakeEnabled(): boolean {
  return strictEnabledByEnv(process.env[requestIntakeEnabledEnv]);
}

export function deviceBridgeApprovalEnabled(): boolean {
  return strictEnabledByEnv(process.env[approvalEnabledEnv]);
}

export function deviceBridgeDescriptorObservationEnabled(): boolean {
  return strictEnabledByEnv(process.env[descriptorObservationEnabledEnv]);
}

export function deviceBridgeDescriptorHmacKey(): string | undefined {
  const key = process.env[descriptorHmacKeyEnv]?.trim();
  return key && key.length >= 32 ? key : undefined;
}

export function deviceBridgeMetadataRegistryEnabled(): boolean {
  return strictEnabledByEnv(process.env[metadataRegistryEnabledEnv]);
}

export function deviceBridgeOperationsEnabled(): false {
  return false;
}

export function deviceBridgeProbeEnabled(): boolean {
  return strictEnabledByEnv(process.env[probeEnabledEnv]);
}

export function deviceBridgeAuditHmacKey(): string | undefined {
  const key = process.env[auditHmacKeyEnv]?.trim();
  return key && key.length >= 32 ? key : undefined;
}

export function deviceBridgeIdentityHmacKey(): string | undefined {
  const key = process.env[identityHmacKeyEnv]?.trim();
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

export function isAvailableDeviceBridgeApprovalRoute(method: string | undefined, pathname: string): boolean {
  return method === 'POST' && /^\/api\/device-bridge\/requests\/[^/]+\/approve$/.test(pathname);
}

export function isAvailableDeviceBridgeProbeRoute(method: string | undefined, pathname: string): boolean {
  if (method === 'POST' && /^\/api\/device-bridge\/approvals\/[^/]+\/start-probe$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/device-bridge\/operations\/[^/]+\/probe$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/device-bridge\/operations\/[^/]+\/confirm$/.test(pathname)) return true;
  if (method === 'GET' && /^\/api\/device-bridge\/operations\/[^/]+\/artifact$/.test(pathname)) return true;
  return false;
}

export function isAvailableDeviceDescriptorObservationRoute(method: string | undefined, pathname: string): boolean {
  return method === 'POST' && /^\/api\/sessions\/[^/]+\/device-bridge\/observations$/.test(pathname);
}

export function isAvailableDeviceBridgeMetadataRoute(method: string | undefined, pathname: string): boolean {
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/device-bridge\/artifacts$/.test(pathname)) return true;
  if (method === 'GET' && /^\/api\/sessions\/[^/]+\/device-bridge\/artifacts$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/device-bridge\/artifacts\/[^/]+\/revoke$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/api/device-bridge/inventory-bindings') return true;
  if (method === 'GET' && pathname === '/api/device-bridge/inventory-bindings') return true;
  if (method === 'POST' && /^\/api\/device-bridge\/inventory-bindings\/[^/]+\/revoke$/.test(pathname)) return true;
  return false;
}

function strictEnabledByEnv(value: string | undefined): boolean {
  return value === 'true';
}
