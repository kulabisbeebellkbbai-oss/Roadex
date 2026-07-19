import type { BrowserDeviceCapability } from '../shared/deviceBridgeContracts';
import type { UsbDeviceFilter } from '../shared/usbDeviceProfileContracts';

export type WebUsbDescriptor = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
};

type UsbChooser = {
  requestDevice: (options: { filters: ReadonlyArray<{ vendorId: number; productId: number }> }) => Promise<WebUsbDescriptor>;
};

export function detectDeviceCapability(navigatorLike: object): BrowserDeviceCapability {
  const identityProbeAvailable = 'serial' in navigatorLike && isSerialChooser(navigatorLike.serial);
  if ('usb' in navigatorLike && isUsbChooser(navigatorLike.usb)) {
    return { transport: 'webusb', identityProbeAvailable, deviceAccessRequested: false };
  }
  return { transport: 'unavailable', identityProbeAvailable, deviceAccessRequested: false };
}

export async function requestUsbDescriptor(navigatorLike: object, filters: UsbDeviceFilter[]): Promise<WebUsbDescriptor> {
  if (!('usb' in navigatorLike) || !isUsbChooser(navigatorLike.usb)) {
    throw new Error('WebUSB is not available in this browser.');
  }
  const device = await navigatorLike.usb.requestDevice({ filters });
  if (!filters.some((filter) => filter.vendorId === device.vendorId && filter.productId === device.productId)) {
    throw new Error('The selected USB device is not allowed for this project.');
  }
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
  };
}

function isUsbChooser(value: unknown): value is UsbChooser {
  return Boolean(value && typeof value === 'object' && 'requestDevice' in value && typeof value.requestDevice === 'function');
}

function isSerialChooser(value: unknown): value is { requestPort: (...args: unknown[]) => Promise<unknown> } {
  return Boolean(value && typeof value === 'object' && 'requestPort' in value && typeof value.requestPort === 'function');
}
