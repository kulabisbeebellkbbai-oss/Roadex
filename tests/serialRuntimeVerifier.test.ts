import { describe, expect, it, vi } from 'vitest';
import { hasSerialRuntimeVerification, verifySerialRuntime } from '../src/client/serialRuntimeVerifier';
import type { SerialVerificationProfile } from '../src/shared/serialVerificationContracts';

const profile: SerialVerificationProfile = {
  id: 'test-runtime',
  workspaceId: 'test-project',
  label: 'Test runtime verification',
  baudRate: 115200,
  bufferSize: 8192,
  timeoutMs: 100,
  requiredMarkers: ['SHT41: missing, BME680: missing', 'BLE provisioning started'],
  successMessage: 'Runtime verified.',
  stages: [
    { marker: 'BLE stage: entering initialization', pendingLabel: 'initializing the BLE device' },
    { marker: 'BLE stage: device initialized', pendingLabel: 'creating the BLE server' },
  ],
};

const immediateProfile = { ...profile, timeoutMs: 1 };

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
    await expect(verifySerialRuntime({ serial: { requestPort } }, profile)).resolves.toEqual({
      profileId: 'test-runtime',
      requiredMarkersObserved: true,
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
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('Serial output was detected');
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
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .resolves.toEqual({ profileId: 'test-runtime', requiredMarkersObserved: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains marker state after earlier serial text is evicted from the rolling window', async () => {
    const close = vi.fn(async () => undefined);
    const chunks = [
      new TextEncoder().encode('SHT41: missing, BME680: missing\n'),
      new TextEncoder().encode('x'.repeat(9000)),
      new TextEncoder().encode('BLE provisioning started\n'),
    ];
    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .resolves.toEqual({ profileId: 'test-runtime', requiredMarkersObserved: true });
  });

  it('does not classify an empty serial chunk as output', async () => {
    const close = vi.fn(async () => undefined);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('No serial output was detected');
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
    await expect(verifySerialRuntime({ serial: { requestPort: async () => port } }, profile))
      .resolves.toEqual({ profileId: 'test-runtime', requiredMarkersObserved: true });
    expect(failedReader.releaseLock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels a pending read before closing after the deadline', async () => {
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const readable = new ReadableStream<Uint8Array>({ cancel });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, immediateProfile))
      .rejects.toThrow('No serial output was detected');
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
        immediateProfile,
      );
      const outcome = expect(verification).rejects.toThrow('No serial output was detected');
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
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('serial connection failed');
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('distinguishes firmware boot without BLE initialization', async () => {
    const close = vi.fn(async () => undefined);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('SHT41: missing, BME680: missing\n'));
        controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('Test runtime verification did not observe every required marker');
  });

  it('reports the last predefined BLE initialization stage without exposing serial output', async () => {
    const close = vi.fn(async () => undefined);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'SHT41: missing, BME680: missing\nBLE stage: entering initialization\nBLE stage: device initialized\n',
        ));
        controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('Test runtime verification stopped while creating the BLE server.');
  });

  it('distinguishes BLE initialization without the expected sensor status', async () => {
    const close = vi.fn(async () => undefined);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('BLE provisioning started\n'));
        controller.close();
      },
    });
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('Test runtime verification did not observe every required marker');
  });

  it('attempts port closure even when reader lock release fails', async () => {
    const close = vi.fn(async () => undefined);
    const reader = {
      read: async () => ({ done: true, value: undefined }),
      releaseLock: () => { throw new Error('release failed'); },
    };
    const readable = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    await expect(verifySerialRuntime({ serial: { requestPort: async () => ({ open: async () => undefined, close, readable }) } }, profile))
      .rejects.toThrow('No serial output was detected');
    expect(close).toHaveBeenCalledOnce();
  });

  it('detects unavailable Web Serial', () => {
    expect(hasSerialRuntimeVerification({})).toBe(false);
  });
});
