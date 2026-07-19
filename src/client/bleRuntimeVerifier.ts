const provisioningServiceUuid = '9e9a0001-6f3d-4f57-9e9f-8c2b9a5f1000';
const statusCharacteristicUuid = '9e9a0008-6f3d-4f57-9e9f-8c2b9a5f1000';

type BluetoothCharacteristic = { readValue: () => Promise<DataView> };
type BluetoothService = { getCharacteristic: (uuid: string) => Promise<BluetoothCharacteristic> };
type BluetoothServer = { getPrimaryService: (uuid: string) => Promise<BluetoothService>; disconnect: () => void };
type BluetoothDevice = { gatt?: { connect: () => Promise<BluetoothServer> } };
type BluetoothNavigator = { bluetooth: { requestDevice: (options: { filters: Array<{ services: string[] }> }) => Promise<BluetoothDevice> } };

export type BleRuntimeVerification = { firmware: string; sht41Present: boolean; bme680Present: boolean };

export function hasBleRuntimeVerification(navigatorLike: object): navigatorLike is object & BluetoothNavigator {
  return 'bluetooth' in navigatorLike && Boolean(
    navigatorLike.bluetooth && typeof navigatorLike.bluetooth === 'object' &&
    'requestDevice' in navigatorLike.bluetooth && typeof navigatorLike.bluetooth.requestDevice === 'function',
  );
}

export async function verifyBleRuntime(navigatorLike: object): Promise<BleRuntimeVerification> {
  if (!hasBleRuntimeVerification(navigatorLike)) throw new Error('Web Bluetooth is not available in this browser.');
  const device = await navigatorLike.bluetooth.requestDevice({ filters: [{ services: [provisioningServiceUuid] }] });
  if (!device.gatt) throw new Error('The selected BLE device does not expose GATT access.');
  let server: BluetoothServer | undefined;
  try {
    server = await device.gatt.connect();
    const service = await server.getPrimaryService(provisioningServiceUuid);
    const characteristic = await service.getCharacteristic(statusCharacteristicUuid);
    const status = parseStatus(new TextDecoder().decode(await characteristic.readValue()));
    if (status.firmware !== '0.1.0') throw new Error('The BLE device is not running the expected firmware version.');
    if (status.sht41Present || status.bme680Present) throw new Error('The BLE status does not match the expected disconnected-sensor state.');
    return status;
  } finally {
    server?.disconnect();
  }
}

function parseStatus(raw: string): BleRuntimeVerification {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('The BLE status response was not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The BLE status response was invalid.');
  const status = value as Record<string, unknown>;
  if (typeof status.firmware !== 'string' || typeof status.sht41 !== 'boolean' || typeof status.bme680 !== 'boolean') {
    throw new Error('The BLE status response was incomplete.');
  }
  return { firmware: status.firmware, sht41Present: status.sht41, bme680Present: status.bme680 };
}
