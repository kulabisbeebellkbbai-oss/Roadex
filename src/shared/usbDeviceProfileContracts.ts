export type UsbDeviceFilter = { vendorId: number; productId: number };
export type UsbDeviceOperation = 'observe' | 'serial.verify' | 'esp32.identity' | 'esp32.flash';

export type UsbDeviceProfile = {
  id: string;
  workspaceId: string;
  label: string;
  filters: UsbDeviceFilter[];
  operations: UsbDeviceOperation[];
};

export function allowsUsbOperation(profile: UsbDeviceProfile | undefined, operation: UsbDeviceOperation): profile is UsbDeviceProfile {
  return Boolean(profile?.operations.includes(operation));
}
