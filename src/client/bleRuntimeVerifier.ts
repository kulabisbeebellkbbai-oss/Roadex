import type { BleVerificationProfile } from '../shared/bleVerificationContracts';

type BluetoothCharacteristic = { readValue: () => Promise<DataView> };
type BluetoothService = { getCharacteristic: (uuid: string) => Promise<BluetoothCharacteristic> };
type BluetoothServer = { getPrimaryService: (uuid: string) => Promise<BluetoothService> };
type BluetoothGatt = { connect: () => Promise<BluetoothServer>; disconnect: () => void };
type BluetoothDevice = { gatt?: BluetoothGatt };
type BluetoothNavigator = { bluetooth: { requestDevice: (options: { filters: Array<{ services: string[] }> }) => Promise<BluetoothDevice> } };

export type BleRuntimeVerification = { profileId: string; expectedFieldsObserved: true };

export function hasBleRuntimeVerification(navigatorLike: object): navigatorLike is object & BluetoothNavigator {
  return 'bluetooth' in navigatorLike && Boolean(
    navigatorLike.bluetooth && typeof navigatorLike.bluetooth === 'object' &&
    'requestDevice' in navigatorLike.bluetooth && typeof navigatorLike.bluetooth.requestDevice === 'function',
  );
}

export async function verifyBleRuntime(navigatorLike: object, profile: BleVerificationProfile): Promise<BleRuntimeVerification> {
  if (!hasBleRuntimeVerification(navigatorLike)) throw new Error('Web Bluetooth is not available in this browser.');
  const device = await navigatorLike.bluetooth.requestDevice({ filters: [{ services: [profile.serviceUuid] }] });
  if (!device.gatt) throw new Error('The selected BLE device does not expose GATT access.');
  const deadline = Date.now() + profile.timeoutMs;
  try {
    const server = await withinDeadline(device.gatt.connect(), deadline);
    const service = await withinDeadline(server.getPrimaryService(profile.serviceUuid), deadline);
    const characteristic = await withinDeadline(service.getCharacteristic(profile.characteristicUuid), deadline);
    const status = parseStatus(new TextDecoder().decode(await withinDeadline(characteristic.readValue(), deadline)));
    if (Object.entries(profile.expectedFields).some(([key, expected]) => status[key] !== expected)) {
      throw new Error(`${profile.label} did not match the configured status fields.`);
    }
    return { profileId: profile.id, expectedFieldsObserved: true };
  } finally {
    device.gatt.disconnect();
  }
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.max(1, deadline - Date.now());
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => globalThis.setTimeout(
      () => reject(new Error('BLE runtime verification timed out.')),
      remaining,
    )),
  ]);
}

function parseStatus(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('The BLE status response was not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The BLE status response was invalid.');
  return value as Record<string, unknown>;
}
