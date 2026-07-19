import { describe, expect, it, vi } from 'vitest';
import { hasSerialRuntimeVerification, verifySerialRuntime } from '../src/client/serialRuntimeVerifier';

describe('serial runtime verifier', () => {
  it('recognizes bounded startup markers without writing to the device', async () => {
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    const chunks = [
      'boot\nSHT41: missing, BME680: missing\n',
      'BLE provisioning started\n',
    ].map((value) => new TextEncoder().encode(value));
    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const requestPort = vi.fn(async () => ({ open, close, readable }));
    await expect(verifySerialRuntime({ serial: { requestPort } }, 100)).resolves.toEqual({
      bleProvisioningStarted: true,
      sensorsAbsent: true,
    });
    expect(open).toHaveBeenCalledWith({ baudRate: 115200, bufferSize: 8192 });
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed when the expected startup markers are absent', async () => {
    const close = vi.fn(async () => undefined);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('unrecognized output'));
        controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, 100))
      .rejects.toThrow('Startup markers were not observed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a bounded rolling window when one serial chunk is oversized', async () => {
    const close = vi.fn(async () => undefined);
    const chunks = [
      new TextEncoder().encode('x'.repeat(9000)),
      new TextEncoder().encode('SHT41: missing, BME680: missing\nBLE provisioning started\n'),
    ];
    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, 100))
      .resolves.toEqual({ bleProvisioningStarted: true, sensorsAbsent: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('recovers from a non-fatal buffer overrun using the replacement readable stream', async () => {
    const close = vi.fn(async () => undefined);
    let current: ReadableStream<Uint8Array>;
    const failedReader = {
      read: async () => { throw new DOMException('A buffer overrun has been detected.', 'BufferOverrunError'); },
      releaseLock: vi.fn(() => { current = replacement; }),
    };
    const replacement = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('SHT41: missing, BME680: missing\nBLE provisioning started\n'));
        controller.close();
      },
    });
    const failed = { getReader: () => failedReader } as unknown as ReadableStream<Uint8Array>;
    current = failed;
    const port = {
      open: async () => undefined,
      close,
      get readable() {
        return current;
      },
    };
    await expect(verifySerialRuntime({ serial: { requestPort: async () => port } }, 100))
      .resolves.toEqual({ bleProvisioningStarted: true, sensorsAbsent: true });
    expect(failedReader.releaseLock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels a pending read before closing after the deadline', async () => {
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const readable = new ReadableStream<Uint8Array>({ cancel });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, 1))
      .rejects.toThrow('Startup markers were not observed');
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('still attempts closure when cancellation and the pending read do not settle', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => undefined);
      const reader = {
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel: () => new Promise<void>(() => undefined),
        releaseLock: vi.fn(),
      };
      const readable = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
      const verification = verifySerialRuntime(
        { serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } },
        1,
      );
      const outcome = expect(verification).rejects.toThrow('Startup markers were not observed');
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
      expect(reader.releaseLock).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry fatal serial read errors', async () => {
    const close = vi.fn(async () => undefined);
    const reader = {
      read: async () => { throw new DOMException('Device disconnected.', 'NetworkError'); },
      releaseLock: vi.fn(),
    };
    const readable = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, 100))
      .rejects.toThrow('serial connection failed');
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('attempts port closure even when reader lock release fails', async () => {
    const close = vi.fn(async () => undefined);
    const reader = {
      read: async () => ({ done: true, value: undefined }),
      releaseLock: () => { throw new Error('release failed'); },
    };
    const readable = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, 100))
      .rejects.toThrow('Startup markers were not observed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('detects unavailable Web Serial', () => {
    expect(hasSerialRuntimeVerification({})).toBe(false);
  });
});
