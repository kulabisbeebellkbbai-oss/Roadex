import type { RoadexSession, StreamEvent } from '../shared/sessionContracts';

export function lifecycleAfterTranscript(
  session: RoadexSession,
  events: StreamEvent[],
): RoadexSession['lifecycle'] {
  const runnerEvents = events.filter(
    (event) => event.kind === 'system' && (isRunnerStart(event) || isRunnerTerminal(event)),
  );
  const latest = runnerEvents[runnerEvents.length - 1];
  if (!latest) return session.lifecycle;
  if (isRunnerStart(latest)) return 'streaming';
  return lifecycleForTerminalEvent(latest) ?? session.lifecycle;
}

export function lifecycleForTerminalEvent(event: StreamEvent): 'ready' | 'blocked' | undefined {
  if (event.message === 'Codex runner completed.' || event.message.includes('Codex runner was cancelled.')) {
    return 'ready';
  }
  if (event.message === 'Codex runner failed.' || event.message.includes('Codex runner timed out')) {
    return 'blocked';
  }
  return undefined;
}

export function isRunnerTerminal(event: StreamEvent): boolean {
  return lifecycleForTerminalEvent(event) !== undefined;
}

function isRunnerStart(event: StreamEvent): boolean {
  return event.message === 'Starting Codex CLI runner.';
}
