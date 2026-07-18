import type { BrowserDeviceCapability } from '../shared/deviceBridgeContracts';

export const approvedUsbFilters = [
  { vendorId: 0x303a, productId: 0x0002 },
  { vendorId: 0x303a, productId: 0x1001 },
  { vendorId: 0x10c4, productId: 0xea60 },
  { vendorId: 0x1a86, productId: 0x7523 },
  { vendorId: 0x1a86, productId: 0x55d4 },
  { vendorId: 0x0403, productId: 0x6001 },
] as const;

export type WebUsbDescriptor = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
};

type UsbChooser = {
  requestDevice: (options: { filters: ReadonlyArray<{ vendorId: number; productId: number }> }) => Promise<WebUsbDescriptor>;
};

export function detectDeviceCapability(navigatorLike: object): BrowserDeviceCapability {
  if ('usb' in navigatorLike && isUsbChooser(navigatorLike.usb)) {
    return { transport: 'webusb', deviceAccessRequested: false };
  }
  return { transport: 'unavailable', deviceAccessRequested: false };
}

export async function requestUsbDescriptor(navigatorLike: object): Promise<WebUsbDescriptor> {
  if (!('usb' in navigatorLike) || !isUsbChooser(navigatorLike.usb)) {
    throw new Error('WebUSB is not available in this browser.');
  }
  const device = await navigatorLike.usb.requestDevice({ filters: approvedUsbFilters });
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
  };
}

function isUsbChooser(value: unknown): value is UsbChooser {
  return Boolean(value && typeof value === 'object' && 'requestDevice' in value && typeof value.requestDevice === 'function');
}
