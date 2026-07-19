type TerminalEvent = 'aborted' | 'close' | 'error';

const DEFAULT_KEEPALIVE_MS = 1_000;
const MIN_KEEPALIVE_MS = 250;
const MAX_KEEPALIVE_MS = 30_000;

export interface TerminalEventSource {
  once(event: TerminalEvent, listener: () => void): unknown;
  off(event: TerminalEvent, listener: () => void): unknown;
}

export function bindLiveStreamCleanup(
  request: TerminalEventSource,
  response: TerminalEventSource,
  onCleanup: () => void,
): () => void {
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.off('aborted', cleanup);
    request.off('close', cleanup);
    response.off('close', cleanup);
    response.off('error', cleanup);
    onCleanup();
  };

  request.once('aborted', cleanup);
  request.once('close', cleanup);
  response.once('close', cleanup);
  response.once('error', cleanup);
  return cleanup;
}

export function resolveLiveStreamKeepaliveMs(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_KEEPALIVE_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_KEEPALIVE_MS || parsed > MAX_KEEPALIVE_MS) {
    throw new Error(`ROADEX_SSE_KEEPALIVE_MS must be an integer from ${MIN_KEEPALIVE_MS} to ${MAX_KEEPALIVE_MS}.`);
  }
  return parsed;
}
