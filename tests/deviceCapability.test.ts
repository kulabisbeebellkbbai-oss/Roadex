import { describe, expect, it } from 'vitest';
import { detectDeviceCapability } from '../src/client/deviceCapability';

describe('browser device capability detection', () => {
  it('detects desktop Web Serial without invoking device APIs', () => {
    let calls = 0;
    const capability = detectDeviceCapability({
      serial: { requestPort: () => { calls += 1; } },
      userAgent: 'Chrome desktop',
    });

    expect(capability).toEqual({ transport: 'web-serial', deviceAccessRequested: false });
    expect(calls).toBe(0);
  });

  it('detects the Android WebUSB polyfill path without opening a chooser', () => {
    let calls = 0;
    const capability = detectDeviceCapability({
      usb: { requestDevice: () => { calls += 1; } },
      userAgent: 'Chrome Android',
    });

    expect(capability).toEqual({ transport: 'webusb-polyfill', deviceAccessRequested: false });
    expect(calls).toBe(0);
  });

  it('does not advertise desktop WebUSB as an approved first-slice transport', () => {
    expect(detectDeviceCapability({ usb: {}, userAgent: 'Chrome desktop' })).toEqual({
      transport: 'unavailable',
      deviceAccessRequested: false,
    });
  });
});
