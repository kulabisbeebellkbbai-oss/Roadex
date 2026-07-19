type TerminalEvent = 'aborted' | 'close' | 'error';

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
