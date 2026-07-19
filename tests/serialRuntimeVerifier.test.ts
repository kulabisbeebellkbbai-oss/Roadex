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
    expect(open).toHaveBeenCalledWith({ baudRate: 115200 });
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

  it('attempts port closure even when reader cancellation and lock release fail', async () => {
    const close = vi.fn(async () => undefined);
    const reader = {
      read: async () => ({ done: true, value: undefined }),
      cancel: async () => { throw new Error('cancel failed'); },
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
