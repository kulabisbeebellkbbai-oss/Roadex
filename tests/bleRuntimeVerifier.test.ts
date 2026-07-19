import { describe, expect, it, vi } from 'vitest';
import { hasBleRuntimeVerification, verifyBleRuntime } from '../src/client/bleRuntimeVerifier';
import type { BleVerificationProfile } from '../src/shared/bleVerificationContracts';

const profile: BleVerificationProfile = {
  id: 'ble-test',
  workspaceId: 'test-project',
  label: 'BLE test',
  serviceUuid: '9e9a0001-6f3d-4f57-9e9f-8c2b9a5f1000',
  characteristicUuid: '9e9a0008-6f3d-4f57-9e9f-8c2b9a5f1000',
  timeoutMs: 100,
  expectedFields: { firmware: '0.1.0', sht41: false, bme680: false },
  successMessage: 'BLE verified.',
};

describe('BLE runtime verifier', () => {
  it('reads only the scoped status characteristic and disconnects', async () => {
    const disconnect = vi.fn();
    const readValue = vi.fn(async () => new DataView(new TextEncoder().encode(JSON.stringify({ firmware: '0.1.0', sht41: false, bme680: false })).buffer));
    const getCharacteristic = vi.fn(async () => ({ readValue }));
    const getPrimaryService = vi.fn(async () => ({ getCharacteristic }));
    const requestDevice = vi.fn(async () => ({ gatt: { connect: async () => ({ getPrimaryService }), disconnect } }));
    await expect(verifyBleRuntime({ bluetooth: { requestDevice } }, profile)).resolves.toEqual({ profileId: 'ble-test', expectedFieldsObserved: true });
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: ['9e9a0001-6f3d-4f57-9e9f-8c2b9a5f1000'] }] });
    expect(getCharacteristic).toHaveBeenCalledWith('9e9a0008-6f3d-4f57-9e9f-8c2b9a5f1000');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('rejects unexpected firmware or connected sensors and still disconnects', async () => {
    const disconnect = vi.fn();
    const navigatorLike = (status: object) => ({ bluetooth: { requestDevice: async () => ({ gatt: { disconnect, connect: async () => ({
      getPrimaryService: async () => ({ getCharacteristic: async () => ({ readValue: async () => new DataView(new TextEncoder().encode(JSON.stringify(status)).buffer) }) }),
    }) } }) } });
    await expect(verifyBleRuntime(navigatorLike({ firmware: 'other', sht41: false, bme680: false }), profile)).rejects.toThrow('configured status fields');
    await expect(verifyBleRuntime(navigatorLike({ firmware: '0.1.0', sht41: true, bme680: false }), profile)).rejects.toThrow('configured status fields');
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('detects unavailable Web Bluetooth', () => {
    expect(hasBleRuntimeVerification({})).toBe(false);
  });

  it('times out a stalled connection and still disconnects', async () => {
    const disconnect = vi.fn();
    const requestDevice = async () => ({ gatt: { disconnect, connect: () => new Promise<never>(() => undefined) } });
    await expect(verifyBleRuntime({ bluetooth: { requestDevice } }, { ...profile, timeoutMs: 1 }))
      .rejects.toThrow('timed out');
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
