import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '../shared/sessionContracts.js';

export function createRunnerIntro(sessionId: string): StreamEvent[] {
  return [
    createStreamEvent(sessionId, 'system', 'Roadex session is attached.'),
    createStreamEvent(
      sessionId,
      'assistant',
      'Device bridge remains disabled until security gates pass.',
    ),
  ];
}

export function createPromptResponse(sessionId: string, prompt: string): StreamEvent[] {
  const cleanPrompt = prompt.trim() || 'empty prompt';
  return [
    createStreamEvent(sessionId, 'system', 'Prompt accepted by mock runner.'),
    createStreamEvent(sessionId, 'assistant', `Reading request: ${cleanPrompt}`),
    createStreamEvent(
      sessionId,
      'assistant',
      'Mock response streamed. Next implementation step is still security-gated.',
    ),
  ];
}

export function createStreamEvent(
  sessionId: string,
  kind: StreamEvent['kind'],
  message: string,
): StreamEvent {
  return {
    id: randomUUID(),
    sessionId,
    kind,
    message,
    at: new Date().toISOString(),
  };
}
