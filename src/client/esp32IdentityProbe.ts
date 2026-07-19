import { ESPLoader, Transport } from 'esptool-js';
import { approvedUsbFilters } from './deviceCapability';

export type Esp32IdentityProbe = {
  vendorId: number;
  productId: number;
  deviceMac: string;
};

type SerialNavigator = {
  serial: {
    requestPort: (options: { filters: Array<{ usbVendorId: number; usbProductId: number }> }) => Promise<SerialPort>;
  };
};

type IdentityProbeSession = {
  readMac: () => Promise<string>;
  disconnect: () => Promise<void>;
};

type IdentityProbeSessionFactory = (port: SerialPort) => IdentityProbeSession;

export async function probeEsp32Identity(
  navigatorLike: object,
  createSession: IdentityProbeSessionFactory = createEsp32ProbeSession,
): Promise<Esp32IdentityProbe> {
  if (!hasSerialChooser(navigatorLike)) throw new Error('Web Serial is not available in this browser.');
  const port = await navigatorLike.serial.requestPort({
    filters: approvedUsbFilters.map(({ vendorId, productId }) => ({
      usbVendorId: vendorId,
      usbProductId: productId,
    })),
  });
  const info = port.getInfo();
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    throw new Error('The selected serial device has no approved USB identity.');
  }

  const session = createSession(port);
  try {
    let deviceMac: string;
    try {
      deviceMac = await session.readMac();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to connect with the device')) {
        throw new Error(
          'ESP32 bootloader connection failed. Hold BOOT, tap RESET/EN, then release BOOT when the connection starts and retry.',
        );
      }
      throw error;
    }
    return {
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
      deviceMac: canonicalMac(deviceMac),
    };
  } finally {
    await session.disconnect().catch(() => undefined);
  }
}

function createEsp32ProbeSession(port: SerialPort): IdentityProbeSession {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    debugLogging: false,
    terminal: { clean() {}, write() {}, writeLine() {} },
  });
  return {
    async readMac() {
      await loader.main();
      return loader.chip.readMac(loader);
    },
    disconnect: () => transport.disconnect(),
  };
}

function hasSerialChooser(value: object): value is object & SerialNavigator {
  return 'serial' in value && Boolean(
    value.serial &&
    typeof value.serial === 'object' &&
    'requestPort' in value.serial &&
    typeof value.serial.requestPort === 'function',
  );
}

function canonicalMac(value: string): string {
  const canonical = value.trim().toLowerCase().replace(/-/g, ':');
  if (!/^[a-f0-9]{2}(?::[a-f0-9]{2}){5}$/.test(canonical)) {
    throw new Error('ESP32 identity probe returned an invalid device identity.');
  }
  return canonical;
}
