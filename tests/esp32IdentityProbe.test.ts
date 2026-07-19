import { describe, expect, it } from 'vitest';
import { probeEsp32Identity } from '../src/client/esp32IdentityProbe';

describe('ESP32 identity probe', () => {
  it('uses approved serial filters, returns a canonical MAC, and disconnects', async () => {
    let requestedOptions: unknown;
    let disconnected = false;
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;

    const result = await probeEsp32Identity({
      serial: {
        async requestPort(options: unknown) {
          requestedOptions = options;
          return port;
        },
      },
    }, (selected) => ({
      async readMac() {
        expect(selected).toBe(port);
        return 'AA-BB-CC-DD-EE-FF';
      },
      async disconnect() {
        disconnected = true;
      },
    }));

    expect(requestedOptions).toMatchObject({ filters: expect.arrayContaining([
      { usbVendorId: 0x10c4, usbProductId: 0xea60 },
    ]) });
    expect(result).toEqual({ vendorId: 0x10c4, productId: 0xea60, deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(disconnected).toBe(true);
  });

  it('disconnects and rejects malformed probe identity', async () => {
    let disconnected = false;
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;

    await expect(probeEsp32Identity({ serial: { async requestPort() { return port; } } }, () => ({
      async readMac() { return 'not-a-mac'; },
      async disconnect() { disconnected = true; },
    }))).rejects.toThrow('invalid device identity');
    expect(disconnected).toBe(true);
  });

  it('reports the manual ESP32 bootloader recovery sequence after connection failure', async () => {
    let disconnected = false;
    const port = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) } as SerialPort;

    await expect(probeEsp32Identity({ serial: { async requestPort() { return port; } } }, () => ({
      async readMac() { throw new Error('Failed to connect with the device'); },
      async disconnect() { disconnected = true; },
    }))).rejects.toThrow('Hold BOOT, tap RESET/EN');
    expect(disconnected).toBe(true);
  });
});
