import { approvedUsbFilters } from './deviceCapability';
import type { SerialVerificationProfile } from '../shared/serialVerificationContracts';

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
  profileId: string;
  requiredMarkersObserved: true;
};

export function hasSerialRuntimeVerification(navigatorLike: object): navigatorLike is object & SerialNavigator {
  return 'serial' in navigatorLike && Boolean(
    navigatorLike.serial && typeof navigatorLike.serial === 'object' &&
    'requestPort' in navigatorLike.serial && typeof navigatorLike.serial.requestPort === 'function',
  );
}

export async function verifySerialRuntime(
  navigatorLike: object,
  profile: SerialVerificationProfile,
): Promise<SerialRuntimeVerification> {
  if (!hasSerialRuntimeVerification(navigatorLike)) throw new Error('Web Serial is not available in this browser.');
  const port = await navigatorLike.serial.requestPort({
    filters: approvedUsbFilters.map(({ vendorId, productId }) => ({ usbVendorId: vendorId, usbProductId: productId })),
  });
  try {
    await port.open({ baudRate: profile.baudRate, bufferSize: profile.bufferSize });
    const deadline = Date.now() + profile.timeoutMs;
    const decoder = new TextDecoder();
    let output = '';
    let receivedOutput = false;
    const requiredMarkers = profile.requiredMarkers.map(() => false);
    let stage = -1;
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
            for (let index = 0; index < profile.requiredMarkers.length; index += 1) {
              requiredMarkers[index] ||= output.includes(profile.requiredMarkers[index]);
            }
            for (let index = stage + 1; index < profile.stages.length; index += 1) {
              if (output.includes(profile.stages[index].marker)) stage = index;
            }
          }
          if (requiredMarkers.every(Boolean)) return { profileId: profile.id, requiredMarkersObserved: true };
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
    throw new Error(classifyIncompleteRuntime(receivedOutput, profile, requiredMarkers, stage));
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
  profile: SerialVerificationProfile,
  requiredMarkers: boolean[],
  stage: number,
): string {
  if (!receivedOutput) return 'No serial output was detected. Start listening, then press RESET/EN once and retry.';
  if (!requiredMarkers.every(Boolean) && stage >= 0) {
    return `${profile.label} stopped while ${profile.stages[stage].pendingLabel}.`;
  }
  return `Serial output was detected, but ${profile.label} did not observe every required marker.`;
}
