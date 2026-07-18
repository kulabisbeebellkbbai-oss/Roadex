import { describe, expect, it } from 'vitest';
import { lifecycleAfterTranscript } from '../src/hooks/sessionSelection';
import type { RoadexSession, StreamEvent } from '../src/shared/sessionContracts';

describe('thread selection lifecycle', () => {
  it('recognizes a background runner that completed while its thread was not selected', () => {
    expect(lifecycleAfterTranscript(session('streaming'), [event('Starting Codex CLI runner.'), event('Codex runner completed.')]))
      .toBe('ready');
  });

  it('keeps a thread streaming when its latest runner has not completed', () => {
    expect(lifecycleAfterTranscript(session('ready'), [event('Codex runner completed.'), event('Starting Codex CLI runner.')]))
      .toBe('streaming');
  });

  it('recognizes a background runner that failed while its thread was not selected', () => {
    expect(lifecycleAfterTranscript(session('streaming'), [event('Starting Codex CLI runner.'), event('Codex runner failed.')]))
      .toBe('blocked');
  });

  it('recognizes a background runner that timed out while its thread was not selected', () => {
    expect(lifecycleAfterTranscript(session('streaming'), [event('Starting Codex CLI runner.'), event('Codex runner timed out after the server limit.')]))
      .toBe('blocked');
  });
});

function session(lifecycle: RoadexSession['lifecycle']): RoadexSession {
  return {
    id: 'session',
    userId: 'user',
    workspace: { id: 'roadex', name: 'Roadex', root: '/srv/roadex' },
    lifecycle,
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function event(message: string): StreamEvent {
  return {
    id: message,
    sessionId: 'session',
    kind: 'system',
    message,
    at: new Date(0).toISOString(),
  };
}
