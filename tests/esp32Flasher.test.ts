import { describe, expect, it, vi } from 'vitest';
import { flashVerifiedEsp32 } from '../src/client/esp32Flasher';

describe('verified ESP32 flasher', () => {
  it('rechecks identity, authorizes, writes, resets, and disconnects in order', async () => {
    const events: string[] = [];
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;
    const navigatorLike = { serial: { requestPort: vi.fn(async () => port) } };
    await flashVerifiedEsp32(
      navigatorLike,
      Uint8Array.from([0xe9, 1, 2, 3]).buffer,
      'aa:bb:cc:dd:ee:ff',
      async (observedMac) => { events.push(`authorized:${observedMac}`); },
      () => ({
        async readMac() { events.push('identity'); return 'AA-BB-CC-DD-EE-FF'; },
        async writeFirmware(bytes) { events.push(`write:${bytes.byteLength}`); },
        async reset() { events.push('reset'); },
        async disconnect() { events.push('disconnect'); },
      }),
    );
    expect(events).toEqual(['identity', 'authorized:aa:bb:cc:dd:ee:ff', 'write:4', 'reset', 'disconnect']);
  });

  it('blocks authorization and writes when the selected identity mismatches', async () => {
    const authorize = vi.fn(async () => undefined);
    const write = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;
    await expect(flashVerifiedEsp32(
      { serial: { requestPort: vi.fn(async () => port) } },
      Uint8Array.from([0xe9, 1]).buffer,
      'aa:bb:cc:dd:ee:ff',
      authorize,
      () => ({ readMac: async () => '00:11:22:33:44:55', writeFirmware: write, reset: vi.fn(), disconnect }),
    )).rejects.toThrow('does not match');
    expect(authorize).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('rejects non-ESP32 images before opening a serial chooser', async () => {
    const requestPort = vi.fn();
    await expect(flashVerifiedEsp32(
      { serial: { requestPort } },
      Uint8Array.from([0, 1]).buffer,
      'aa:bb:cc:dd:ee:ff',
      vi.fn(),
    )).rejects.toThrow('not an ESP32 application image');
    expect(requestPort).not.toHaveBeenCalled();
  });

  it('rejects a returned descriptor outside the approved allowlist', async () => {
    const port = { getInfo: () => ({ usbVendorId: 0xffff, usbProductId: 0xffff }) } as SerialPort;
    const createSession = vi.fn();
    await expect(flashVerifiedEsp32(
      { serial: { requestPort: vi.fn(async () => port) } },
      Uint8Array.from([0xe9, 1]).buffer,
      'aa:bb:cc:dd:ee:ff',
      vi.fn(),
      createSession,
    )).rejects.toThrow('not on the approved USB allowlist');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not write when server authorization is rejected after identity verification', async () => {
    const write = vi.fn();
    const reset = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;
    await expect(flashVerifiedEsp32(
      { serial: { requestPort: vi.fn(async () => port) } },
      Uint8Array.from([0xe9, 1]).buffer,
      'aa:bb:cc:dd:ee:ff',
      async () => { throw new Error('authorization expired'); },
      () => ({ readMac: async () => 'aa:bb:cc:dd:ee:ff', writeFirmware: write, reset, disconnect }),
    )).rejects.toThrow('authorization expired');
    expect(write).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not reset after a failed physical write and always disconnects', async () => {
    const reset = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;
    await expect(flashVerifiedEsp32(
      { serial: { requestPort: vi.fn(async () => port) } },
      Uint8Array.from([0xe9, 1]).buffer,
      'aa:bb:cc:dd:ee:ff',
      async () => undefined,
      () => ({
        readMac: async () => 'aa:bb:cc:dd:ee:ff',
        writeFirmware: async () => { throw new Error('write failed'); },
        reset,
        disconnect,
      }),
    )).rejects.toThrow('write failed');
    expect(reset).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
