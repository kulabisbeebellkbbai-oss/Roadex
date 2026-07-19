import { ESPLoader, Transport } from 'esptool-js';
import SparkMD5 from 'spark-md5';
import { approvedUsbFilters } from './deviceCapability';

type SerialNavigator = {
  serial: {
    requestPort: (options: { filters: Array<{ usbVendorId: number; usbProductId: number }> }) => Promise<SerialPort>;
  };
};

type FlashSession = {
  readMac: () => Promise<string>;
  writeFirmware: (bytes: Uint8Array) => Promise<void>;
  reset: () => Promise<void>;
  disconnect: () => Promise<void>;
};

type FlashSessionFactory = (port: SerialPort) => FlashSession;

export async function flashVerifiedEsp32(
  navigatorLike: object,
  firmware: ArrayBuffer,
  expectedDeviceMac: string,
  authorizeWrite: (observedDeviceMac: string) => Promise<void>,
  createSession: FlashSessionFactory = createEsp32FlashSession,
): Promise<void> {
  if (!hasSerialChooser(navigatorLike)) throw new Error('Web Serial is not available in this browser.');
  const bytes = new Uint8Array(firmware);
  if (bytes.byteLength === 0 || bytes[0] !== 0xe9) throw new Error('The verified firmware is not an ESP32 application image.');
  const expectedMac = canonicalMac(expectedDeviceMac);
  const port = await navigatorLike.serial.requestPort({
    filters: approvedUsbFilters.map(({ vendorId, productId }) => ({ usbVendorId: vendorId, usbProductId: productId })),
  });
  const info = port.getInfo();
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    throw new Error('The selected serial device has no approved USB identity.');
  }
  if (!approvedUsbFilters.some(({ vendorId, productId }) => vendorId === info.usbVendorId && productId === info.usbProductId)) {
    throw new Error('The selected serial device is not on the approved USB allowlist.');
  }

  const session = createSession(port);
  try {
    const observedMac = canonicalMac(await session.readMac());
    if (observedMac !== expectedMac) throw new Error('The selected ESP32 does not match the verified inventory device.');
    await authorizeWrite(observedMac);
    await session.writeFirmware(bytes);
    await session.reset();
  } finally {
    await session.disconnect().catch(() => undefined);
  }
}

function createEsp32FlashSession(port: SerialPort): FlashSession {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    debugLogging: false,
    terminal: { clean() {}, write() {}, writeLine() {} },
  });
  let connected = false;
  const connect = async () => {
    if (!connected) {
      await loader.main();
      connected = true;
    }
  };
  return {
    async readMac() {
      await connect();
      return loader.chip.readMac(loader);
    },
    async writeFirmware(bytes) {
      await connect();
      await loader.writeFlash({
        fileArray: [{ data: bytes, address: 0x10000 }],
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'keep',
        eraseAll: false,
        compress: true,
        calculateMD5Hash: (image) => SparkMD5.ArrayBuffer.hash(image.slice().buffer),
      });
    },
    async reset() {
      await loader.after('hard_reset');
    },
    disconnect: () => transport.disconnect(),
  };
}

function hasSerialChooser(value: object): value is object & SerialNavigator {
  return 'serial' in value && Boolean(
    value.serial && typeof value.serial === 'object' &&
    'requestPort' in value.serial && typeof value.serial.requestPort === 'function',
  );
}

function canonicalMac(value: string): string {
  const canonical = value.trim().toLowerCase().replace(/-/g, ':');
  if (!/^[a-f0-9]{2}(?::[a-f0-9]{2}){5}$/.test(canonical)) throw new Error('ESP32 identity is invalid.');
  return canonical;
}
