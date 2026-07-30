import { describe, expect, it } from 'vitest';
import { lifecycleAfterTranscript, resolveRememberedSession } from '../src/hooks/sessionSelection';
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

  it('preserves authoritative ready state after the removed legacy timeout sequence', () => {
    expect(lifecycleAfterTranscript(session('ready'), [
      event('Starting Codex CLI runner.'),
      event('Codex runner timed out and was stopped.'),
      event('Codex runner failed.'),
    ])).toBe('ready');
  });

  it('does not reinterpret an unrecovered legacy timeout sequence as ready', () => {
    expect(lifecycleAfterTranscript(session('blocked'), [
      event('Starting Codex CLI runner.'),
      event('Codex runner timed out and was stopped.'),
      event('Codex runner failed.'),
    ])).toBe('blocked');
  });

  it('restores only an exact active session returned for the current owner', () => {
    const first = session('ready', 'session-first');
    const selected = session('ready', 'session-selected');
    expect(resolveRememberedSession([first, selected], selected.id)).toBe(selected);
    expect(resolveRememberedSession([first, selected], 'session-other-owner')).toBe(first);
    expect(resolveRememberedSession([first, selected], undefined)).toBe(first);
  });
});

function session(lifecycle: RoadexSession['lifecycle'], id = 'session'): RoadexSession {
  return {
    id,
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
