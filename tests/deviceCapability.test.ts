import { describe, expect, it } from 'vitest';
import { detectDeviceCapability, requestUsbDescriptor } from '../src/client/deviceCapability';

const usbFilters = [{ vendorId: 0x10c4, productId: 0xea60 }];

describe('browser device capability detection', () => {
  it('detects Web Serial without opening a chooser', () => {
    let calls = 0;
    const capability = detectDeviceCapability({
      serial: { requestPort: () => { calls += 1; } },
      userAgent: 'Chrome desktop',
    });

    expect(capability).toEqual({ transport: 'unavailable', identityProbeAvailable: true, deviceAccessRequested: false });
    expect(calls).toBe(0);
  });

  it('detects WebUSB without opening a chooser', () => {
    let calls = 0;
    const capability = detectDeviceCapability({
      usb: { requestDevice: () => { calls += 1; } },
      userAgent: 'Chrome Android',
    });

    expect(capability).toEqual({ transport: 'webusb', identityProbeAvailable: false, deviceAccessRequested: false });
    expect(calls).toBe(0);
  });

  it('advertises desktop WebUSB without invoking it', () => {
    expect(detectDeviceCapability({ usb: { requestDevice() {} }, userAgent: 'Chrome desktop' })).toEqual({
      transport: 'webusb',
      identityProbeAvailable: false,
      deviceAccessRequested: false,
    });
    expect(detectDeviceCapability({ usb: {}, userAgent: 'Chrome desktop' })).toEqual({
      transport: 'unavailable',
      identityProbeAvailable: false,
      deviceAccessRequested: false,
    });
  });

  it('requests only approved descriptors and never opens or transfers to the device', async () => {
    let receivedFilters: unknown;
    let openCalls = 0;
    const descriptor = await requestUsbDescriptor({
      usb: {
        async requestDevice(options: unknown) {
          receivedFilters = options;
          return {
            vendorId: 0x10c4,
            productId: 0xea60,
            serialNumber: 'private-serial',
            open() { openCalls += 1; },
            transferOut() { throw new Error('must not be called'); },
          };
        },
    },
    }, usbFilters);

    expect(receivedFilters).toEqual({ filters: usbFilters });
    expect(descriptor).toEqual({ vendorId: 0x10c4, productId: 0xea60, serialNumber: 'private-serial' });
    expect(openCalls).toBe(0);
    expect('open' in descriptor).toBe(false);
  });

  it('rejects a chooser result outside the project filters', async () => {
    await expect(requestUsbDescriptor({
      usb: { requestDevice: async () => ({ vendorId: 0xffff, productId: 0xffff }) },
    }, usbFilters)).rejects.toThrow('not allowed for this project');
  });
});
