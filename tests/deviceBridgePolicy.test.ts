import { describe, expect, it } from 'vitest';
import {
  deviceBridgeOperationsEnabled,
  deviceBridgeRequestIntakeEnabled,
  getDeviceBridgePolicy,
  isAvailableDeviceBridgeIntakeRoute,
} from '../src/server/deviceBridgePolicy';

describe('device bridge intake policy', () => {
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

  it('exposes only the pending request intake route as an available bridge route', () => {
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
});

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}
