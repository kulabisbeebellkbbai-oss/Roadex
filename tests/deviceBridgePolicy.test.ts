import { describe, expect, it } from 'vitest';
import {
  deviceBridgeIdentityHmacKey,
  deviceBridgeMetadataRegistryEnabled,
  deviceBridgeOperationsEnabled,
  deviceBridgeApprovalEnabled,
  deviceBridgeRequestIntakeEnabled,
  getDeviceBridgePolicy,
  isAvailableDeviceBridgeApprovalRoute,
  isAvailableDeviceBridgeIntakeRoute,
  isAvailableDeviceBridgeMetadataRoute,
} from '../src/server/deviceBridgePolicy';

describe('device bridge intake policy', () => {
  it('keeps approval strictly default-off', () => {
    const original = process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED;
    try {
      delete process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED;
      expect(deviceBridgeApprovalEnabled()).toBe(false);
      process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = 'true';
      expect(deviceBridgeApprovalEnabled()).toBe(true);
      process.env.ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED = '1';
      expect(deviceBridgeApprovalEnabled()).toBe(false);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_APPROVAL_ENABLED', original);
    }
  });
  it('defaults request intake false and fails closed for malformed booleans', () => {
    const original = process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
    try {
      delete process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED;
      expect(deviceBridgeRequestIntakeEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'false';
      expect(deviceBridgeRequestIntakeEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = '1';
      expect(deviceBridgeRequestIntakeEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'True';
      expect(deviceBridgeRequestIntakeEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED = 'true';
      expect(deviceBridgeRequestIntakeEnabled()).toBe(true);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED', original);
    }
  });

  it('keeps operations hard false regardless of production env', () => {
    const original = process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED;
    try {
      delete process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED;
      expect(deviceBridgeOperationsEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED = 'true';
      expect(deviceBridgeOperationsEnabled()).toBe(false);

      expect(getDeviceBridgePolicy()).toMatchObject({
        state: 'disabled',
        operationsEnabled: false,
      });
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED', original);
    }
  });

  it('defaults metadata registry false and fails closed for malformed booleans', () => {
    const original = process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
    try {
      delete process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED;
      expect(deviceBridgeMetadataRegistryEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'false';
      expect(deviceBridgeMetadataRegistryEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = '1';
      expect(deviceBridgeMetadataRegistryEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'True';
      expect(deviceBridgeMetadataRegistryEnabled()).toBe(false);

      process.env.ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED = 'true';
      expect(deviceBridgeMetadataRegistryEnabled()).toBe(true);
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED', original);
    }
  });

  it('requires a separate strong identity HMAC key for device pseudonyms', () => {
    const original = process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
    try {
      delete process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY;
      expect(deviceBridgeIdentityHmacKey()).toBeUndefined();

      process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = 'too-short';
      expect(deviceBridgeIdentityHmacKey()).toBeUndefined();

      process.env.ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY = 'test-device-bridge-identity-hmac-key-32';
      expect(deviceBridgeIdentityHmacKey()).toBe('test-device-bridge-identity-hmac-key-32');
    } finally {
      restoreEnv('ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY', original);
    }
  });

  it('exposes only the pending request intake route as an available intake bridge route', () => {
    expect(isAvailableDeviceBridgeIntakeRoute(
      'POST',
      '/api/sessions/session-1/device-bridge/requests',
    )).toBe(true);

    for (const [method, path] of [
      ['GET', '/api/sessions/session-1/device-bridge/requests'],
      ['POST', '/api/device-bridge/requests/request-1/approve'],
      ['POST', '/api/device-bridge/approvals/approval-1/start'],
      ['GET', '/api/device-bridge/operations/operation-1/artifact'],
      ['POST', '/api/device-bridge/operations/operation-1/probe'],
      ['POST', '/api/device-bridge/operations/operation-1/authorize-write'],
      ['POST', '/api/device-bridge/operations/operation-1/cancel'],
    ] as const) {
      expect(isAvailableDeviceBridgeIntakeRoute(method, path)).toBe(false);
    }
  });

  it('exposes only the owner approval route as an available approval bridge route', () => {
    expect(isAvailableDeviceBridgeApprovalRoute(
      'POST',
      '/api/device-bridge/requests/request-1/approve',
    )).toBe(true);

    for (const [method, path] of [
      ['GET', '/api/device-bridge/requests/request-1/approve'],
      ['POST', '/api/device-bridge/requests/request-1'],
      ['POST', '/api/device-bridge/approvals/approval-1/start'],
      ['POST', '/api/device-bridge/operations/operation-1/probe'],
      ['POST', '/api/sessions/session-1/device-bridge/requests'],
    ] as const) {
      expect(isAvailableDeviceBridgeApprovalRoute(method, path)).toBe(false);
    }
  });

  it('exposes only artifact metadata and inventory binding registry routes', () => {
    for (const [method, path] of [
      ['POST', '/api/sessions/session-1/device-bridge/artifacts'],
      ['GET', '/api/sessions/session-1/device-bridge/artifacts'],
      ['POST', '/api/sessions/session-1/device-bridge/artifacts/artifact-1/revoke'],
      ['POST', '/api/device-bridge/inventory-bindings'],
      ['GET', '/api/device-bridge/inventory-bindings'],
      ['POST', '/api/device-bridge/inventory-bindings/binding-1/revoke'],
    ] as const) {
      expect(isAvailableDeviceBridgeMetadataRoute(method, path)).toBe(true);
    }

    for (const [method, path] of [
      ['GET', '/api/sessions/session-1/device-bridge/artifacts/artifact-1'],
      ['GET', '/api/sessions/session-1/device-bridge/artifacts/artifact-1/bytes'],
      ['POST', '/api/sessions/session-1/device-bridge/browser-chooser'],
      ['POST', '/api/sessions/session-1/device-bridge/usb'],
      ['POST', '/api/device-bridge/approvals/approval-1/start'],
      ['GET', '/api/device-bridge/operations/operation-1/artifact'],
      ['POST', '/api/device-bridge/operations/operation-1/probe'],
      ['POST', '/api/device-bridge/operations/operation-1/authorize-write'],
      ['POST', '/api/device-bridge/operations/operation-1/flash'],
      ['POST', '/api/device-bridge/operations/operation-1/cancel'],
    ] as const) {
      expect(isAvailableDeviceBridgeMetadataRoute(method, path)).toBe(false);
    }
  });
});

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}
