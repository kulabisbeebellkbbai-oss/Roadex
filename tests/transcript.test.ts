import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/shared/sessionContracts';
import { isVisibleTranscriptEvent, shouldFollowTranscript } from '../src/transcript';

function event(message: string): StreamEvent {
  return {
    id: message,
    sessionId: 'session-one',
    kind: 'system',
    message,
    at: '2026-07-18T00:00:00.000Z',
  };
}

describe('isVisibleTranscriptEvent', () => {
  it('suppresses successful Codex runner lifecycle messages', () => {
    expect(isVisibleTranscriptEvent(event('Starting Codex CLI runner.'))).toBe(false);
    expect(isVisibleTranscriptEvent(event('Codex runner completed.'))).toBe(false);
  });

  it('keeps replies, requests, and actionable runner status messages visible', () => {
    expect(isVisibleTranscriptEvent(event('Assistant reply'))).toBe(true);
    expect(isVisibleTranscriptEvent(event('Codex runner timed out and was stopped.'))).toBe(true);
  });
});

describe('shouldFollowTranscript', () => {
  it('follows near the bottom and preserves deliberate scrollback', () => {
    expect(shouldFollowTranscript(1_000, 520, 400)).toBe(false);
    expect(shouldFollowTranscript(1_000, 521, 400)).toBe(true);
    expect(shouldFollowTranscript(1_000, 600, 400)).toBe(true);
  });
});
