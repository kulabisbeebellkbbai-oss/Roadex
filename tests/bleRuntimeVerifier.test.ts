import { describe, expect, it, vi } from 'vitest';
import { hasBleRuntimeVerification, verifyBleRuntime } from '../src/client/bleRuntimeVerifier';

describe('BLE runtime verifier', () => {
  it('reads only the scoped status characteristic and disconnects', async () => {
    const disconnect = vi.fn();
    const readValue = vi.fn(async () => new DataView(new TextEncoder().encode(JSON.stringify({ firmware: '0.1.0', sht41: false, bme680: false })).buffer));
    const getCharacteristic = vi.fn(async () => ({ readValue }));
    const getPrimaryService = vi.fn(async () => ({ getCharacteristic }));
    const requestDevice = vi.fn(async () => ({ gatt: { connect: async () => ({ getPrimaryService, disconnect }) } }));
    await expect(verifyBleRuntime({ bluetooth: { requestDevice } })).resolves.toEqual({ firmware: '0.1.0', sht41Present: false, bme680Present: false });
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: ['9e9a0001-6f3d-4f57-9e9f-8c2b9a5f1000'] }] });
    expect(getCharacteristic).toHaveBeenCalledWith('9e9a0008-6f3d-4f57-9e9f-8c2b9a5f1000');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('rejects unexpected firmware or connected sensors and still disconnects', async () => {
    const disconnect = vi.fn();
    const navigatorLike = (status: object) => ({ bluetooth: { requestDevice: async () => ({ gatt: { connect: async () => ({
      disconnect,
      getPrimaryService: async () => ({ getCharacteristic: async () => ({ readValue: async () => new DataView(new TextEncoder().encode(JSON.stringify(status)).buffer) }) }),
    }) } }) } });
    await expect(verifyBleRuntime(navigatorLike({ firmware: 'other', sht41: false, bme680: false }))).rejects.toThrow('expected firmware');
    await expect(verifyBleRuntime(navigatorLike({ firmware: '0.1.0', sht41: true, bme680: false }))).rejects.toThrow('disconnected-sensor state');
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('detects unavailable Web Bluetooth', () => {
    expect(hasBleRuntimeVerification({})).toBe(false);
  });
});
