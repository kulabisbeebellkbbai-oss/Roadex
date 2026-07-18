import type { BrowserDeviceCapability } from '../shared/deviceBridgeContracts';

type NavigatorCapabilities = {
  serial?: unknown;
  usb?: unknown;
  userAgent?: string;
};

export function detectDeviceCapability(navigatorLike: NavigatorCapabilities): BrowserDeviceCapability {
  if (navigatorLike.serial) {
    return { transport: 'web-serial', deviceAccessRequested: false };
  }
  if (navigatorLike.usb && /Android/i.test(navigatorLike.userAgent ?? '')) {
    return { transport: 'webusb-polyfill', deviceAccessRequested: false };
  }
  return { transport: 'unavailable', deviceAccessRequested: false };
}
