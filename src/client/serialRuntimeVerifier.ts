import { approvedUsbFilters } from './deviceCapability';

type RuntimeSerialPort = {
  open: (options: { baudRate: number; bufferSize: number }) => Promise<void>;
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

const bleStageMarkers = [
  ['BLE stage: entering initialization', 'entering BLE initialization'],
  ['BLE stage: device initialized', 'creating the BLE server'],
  ['BLE stage: server created', 'creating the provisioning service'],
  ['BLE stage: service created', 'configuring provisioning characteristics'],
  ['BLE stage: characteristics configured', 'starting the provisioning service'],
  ['BLE stage: service started', 'configuring BLE advertising'],
  ['BLE stage: advertising configured', 'starting BLE advertising'],
] as const;

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
  try {
    await port.open({ baudRate: 115200, bufferSize: 8192 });
    const deadline = Date.now() + timeoutMs;
    const decoder = new TextDecoder();
    let output = '';
    let receivedOutput = false;
    let sensorsHandled = false;
    let bleStarted = false;
    let bleStage = -1;
    while (port.readable && Date.now() < deadline) {
      const stream = port.readable;
      const reader = stream.getReader();
      let recoverOverrun = false;
      let streamEnded = false;
      try {
        while (Date.now() < deadline) {
          const remaining = Math.max(1, deadline - Date.now());
          const timeout = Symbol('serial-read-timeout');
          let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
          const pendingRead = reader.read();
          const result = await Promise.race([
            pendingRead,
            new Promise<typeof timeout>((resolve) => {
              timeoutId = globalThis.setTimeout(() => resolve(timeout), remaining);
            }),
          ]);
          if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
          if (result === timeout) {
            await settleWithin(reader.cancel().catch(() => undefined), 250);
            await settleWithin(pendingRead.catch(() => undefined), 250);
            streamEnded = true;
            break;
          }
          if (result.value && result.value.byteLength > 0) {
            receivedOutput = true;
            output = (output + decoder.decode(result.value, { stream: true })).slice(-8192);
            sensorsHandled ||= output.includes('SHT41: missing, BME680: missing');
            bleStarted ||= output.includes('BLE provisioning started');
            for (let index = bleStage + 1; index < bleStageMarkers.length; index += 1) {
              if (output.includes(bleStageMarkers[index][0])) bleStage = index;
            }
          }
          if (sensorsHandled && bleStarted) return { bleProvisioningStarted: true, sensorsAbsent: true };
          if (result.done) {
            streamEnded = true;
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'BufferOverrunError') {
          throw new Error('The serial connection failed while reading startup output. Reconnect the ESP32 and retry.');
        }
        recoverOverrun = true;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Port closure is attempted independently below.
        }
      }
      if (streamEnded) break;
      if (recoverOverrun) {
        await Promise.resolve();
        if (!port.readable || port.readable === stream) {
          throw new Error('The serial receive buffer overrun could not be recovered. Retry the verification.');
        }
      }
    }
    throw new Error(classifyIncompleteRuntime(receivedOutput, sensorsHandled, bleStarted, bleStage));
  } finally {
    await settleWithin(port.close().catch(() => undefined), 250);
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise,
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, timeoutMs)),
  ]);
}

function classifyIncompleteRuntime(
  receivedOutput: boolean,
  sensorsHandled: boolean,
  bleStarted: boolean,
  bleStage: number,
): string {
  if (!receivedOutput) return 'No serial output was detected. Start listening, then press RESET/EN once and retry.';
  if (sensorsHandled && !bleStarted && bleStage >= 0) {
    return `Firmware booted, but BLE initialization stopped while ${bleStageMarkers[bleStage][1]}.`;
  }
  if (sensorsHandled && !bleStarted) return 'Firmware booted and handled the disconnected sensors, but BLE initialization was not detected.';
  if (!sensorsHandled && bleStarted) return 'BLE initialization started, but the disconnected-sensor startup status was not detected.';
  return 'Serial output was detected, but it did not match the expected firmware startup markers.';
}
