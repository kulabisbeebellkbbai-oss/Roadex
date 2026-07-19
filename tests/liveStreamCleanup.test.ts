import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { bindLiveStreamCleanup, type TerminalEventSource } from '../server/liveStreamCleanup.js';

describe('live stream cleanup', () => {
  it.each([
    ['request aborted', 'request', 'aborted'],
    ['request closed', 'request', 'close'],
    ['response closed', 'response', 'close'],
    ['response errored', 'response', 'error'],
  ] as const)('cleans up when the %s', (_label, source, event) => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    const onCleanup = vi.fn();

    bindLiveStreamCleanup(request as TerminalEventSource, response as TerminalEventSource, onCleanup);
    (source === 'request' ? request : response).emit(event);

    expect(onCleanup).toHaveBeenCalledOnce();
  });

  it('unsubscribes exactly once across repeated terminal signals', () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    const onCleanup = vi.fn();
    const cleanup = bindLiveStreamCleanup(
      request as TerminalEventSource,
      response as TerminalEventSource,
      onCleanup,
    );

    request.emit('aborted');
    request.emit('close');
    response.emit('close');
    cleanup();

    expect(onCleanup).toHaveBeenCalledOnce();
  });
});
