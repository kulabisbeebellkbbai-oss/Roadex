import { approvedUsbFilters } from './deviceCapability';

type RuntimeSerialPort = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
};

type SerialNavigator = {
  serial: {
    requestPort: (options: { filters: Array<{ usbVendorId: number; usbProductId: number }> }) => Promise<RuntimeSerialPort>;
  };
};

export type SerialRuntimeVerification = {
  bleProvisioningStarted: true;
  sensorsAbsent: true;
};

export function hasSerialRuntimeVerification(navigatorLike: object): navigatorLike is object & SerialNavigator {
  return 'serial' in navigatorLike && Boolean(
    navigatorLike.serial && typeof navigatorLike.serial === 'object' &&
    'requestPort' in navigatorLike.serial && typeof navigatorLike.serial.requestPort === 'function',
  );
}

export async function verifySerialRuntime(
  navigatorLike: object,
  timeoutMs = 15_000,
): Promise<SerialRuntimeVerification> {
  if (!hasSerialRuntimeVerification(navigatorLike)) throw new Error('Web Serial is not available in this browser.');
  const port = await navigatorLike.serial.requestPort({
    filters: approvedUsbFilters.map(({ vendorId, productId }) => ({ usbVendorId: vendorId, usbProductId: productId })),
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await port.open({ baudRate: 115200 });
    if (!port.readable) throw new Error('The selected serial device did not provide a readable stream.');
    reader = port.readable.getReader();
    const deadline = Date.now() + timeoutMs;
    const decoder = new TextDecoder();
    let output = '';
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) => globalThis.setTimeout(() => resolve({ done: true }), remaining)),
      ]);
      if (result.value) output = (output + decoder.decode(result.value, { stream: true })).slice(-8192);
      if (hasRuntimeMarkers(output)) return { bleProvisioningStarted: true, sensorsAbsent: true };
      if (result.done) break;
    }
    throw new Error('Startup markers were not observed. Press RESET/EN after serial listening begins, then retry.');
  } finally {
    if (reader) {
      await Promise.race([
        reader.cancel().catch(() => undefined),
        new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250)),
      ]);
      try {
        reader.releaseLock();
      } catch {
        // Port closure is attempted independently below.
      }
    }
    await port.close().catch(() => undefined);
  }
}

function hasRuntimeMarkers(output: string): boolean {
  return output.includes('SHT41: missing, BME680: missing') && output.includes('BLE provisioning started');
}
