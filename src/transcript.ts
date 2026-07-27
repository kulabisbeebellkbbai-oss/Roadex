import type { StreamEvent } from './shared/sessionContracts';

const HIDDEN_RUNNER_MESSAGES = new Set([
  'Starting Codex CLI runner.',
  'Codex runner completed.',
]);

export function isVisibleTranscriptEvent(event: StreamEvent): boolean {
  return !HIDDEN_RUNNER_MESSAGES.has(event.message);
}

export function shouldFollowTranscript(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}
