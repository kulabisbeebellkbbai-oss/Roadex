import type { BleVerificationProfile } from './bleVerificationContracts.js';
import type { SerialVerificationProfile } from './serialVerificationContracts.js';
import type { UsbDeviceProfile } from './usbDeviceProfileContracts.js';

export type ProjectDeviceManifest = {
  version: 1;
  projects: ProjectDeviceConfiguration[];
};

export type ProjectDeviceConfiguration = {
  workspaceId: string;
  usb?: Omit<UsbDeviceProfile, 'workspaceId'>;
  serial?: Omit<SerialVerificationProfile, 'workspaceId'>;
  ble?: Omit<BleVerificationProfile, 'workspaceId'>;
};

export type LoadedProjectDeviceProfiles = {
  serialVerificationProfiles: SerialVerificationProfile[];
  bleVerificationProfiles: BleVerificationProfile[];
  usbDeviceProfiles: UsbDeviceProfile[];
};
