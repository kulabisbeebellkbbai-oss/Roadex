import { describe, expect, it, vi } from 'vitest';
import { ProjectHumanThreadTranscriptRelayCoordinator } from '../src/server/projectHumanThreadTranscriptRelay';
import { ProjectHumanThreadRelay } from '../src/server/projectHumanThreadRelay';
import { ProjectHumanThreadTranscriptStore } from '../src/server/projectHumanThreadTranscriptStore';
import { messageDigest, type ProjectHumanThreadBinding, type ProjectHumanThreadMessage } from '../src/shared/projectHumanThreadContracts';

const binding = {
  schemaVersion: 'roadex.project-human-thread-binding.v1',
  bindingId: 'project-human-thread:arcade:1', projectId: 'arcade',
  root: { canonicalPath: '/workspace/Arcade', dev: '1', ino: '2' }, purpose: 'human-interaction',
  conversationId: '11111111-1111-1111-1111-111111111111', generation: 1, status: 'active',
  predecessorGeneration: null, creationMode: 'created', provenanceDigest: 'a'.repeat(64),
  createdAt: '2026-08-22T13:00:00.000Z', updatedAt: '2026-08-22T13:00:00.000Z', retiredAt: null,
  recordDigest: 'b'.repeat(64),
} as ProjectHumanThreadBinding;

const questionWithoutDigest = {
  schemaVersion: 'roadex.project-human-thread-message.v1', messageId: 'question-1', projectId: 'arcade',
  conversationId: binding.conversationId, generation: 1, kind: 'question', content: 'Continue?', choices: [],
  correlationId: 'correlation-1', idempotencyKey: 'question-key-1', occurredAt: '2026-08-22T13:00:00.000Z',
} as const;
const question = {
  ...questionWithoutDigest,
  contentDigest: messageDigest.content(questionWithoutDigest.content),
  messageDigest: messageDigest.record({ ...questionWithoutDigest, contentDigest: messageDigest.content(questionWithoutDigest.content) }),
} as ProjectHumanThreadMessage;

describe('project human thread transcript relay coordinator', () => {
  it('delivers the response identity, not the transcript event identity', async () => {
    const store = new ProjectHumanThreadTranscriptStore(() => binding, { databasePath: ':memory:', now: () => '2026-08-22T13:00:00.000Z' });
    store.receiveQuestion(question, 'nonce-1', '2026-08-22T13:00:00.000Z');
    const response = store.submitResponse('arcade', question.messageId, 'Yes', 'response-key-1');
    const relay = {
      enqueueResponse: vi.fn(),
      deliver: vi.fn(async (recordId: string) => ({ state: 'delivered' as const, recordId })),
    } as unknown as ProjectHumanThreadRelay;
    const coordinator = new ProjectHumanThreadTranscriptRelayCoordinator(store, relay);
    const result = await coordinator.retryResponses();
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(relay.enqueueResponse).toHaveBeenCalledWith(response.response);
    expect(relay.deliver).toHaveBeenCalledWith(response.response.responseId);
    expect(store.pendingResponseOutbox()).toHaveLength(0);
    store.close();
  });
});
