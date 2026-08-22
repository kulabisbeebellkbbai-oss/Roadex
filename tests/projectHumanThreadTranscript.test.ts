import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  messageDigest,
  type ProjectHumanThreadBinding,
  type ProjectHumanThreadMessage,
} from '../src/shared/projectHumanThreadContracts';
import {
  PROJECT_HUMAN_THREAD_QUESTION_REQUEST_DOMAIN,
  PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_DOMAIN,
  parseProjectHumanThreadQuestionReceipt,
  questionSha256,
  questionStableJson,
} from '../src/shared/projectHumanThreadQuestionContracts';
import { ProjectHumanThreadQuestionReceiver } from '../src/server/projectHumanThreadQuestionReceiver';
import { ProjectHumanThreadTranscriptStore } from '../src/server/projectHumanThreadTranscriptStore';
import { ProjectHumanThreadTranscriptController } from '../src/server/projectHumanThreadTranscriptController';

const now = '2026-08-22T13:00:00.000Z';
const secret = 'transcript-test-secret-with-at-least-32-bytes';
const project = { id: 'arcade', root: '/srv/projects/arcade' };
const owner = { id: 'owner', displayName: 'Owner', authMode: 'mock' as const, roles: ['user' as const] };
const binding = {
  schemaVersion: 'roadex.project-human-thread-binding.v1',
  bindingId: 'project-human-thread:arcade:1',
  projectId: project.id,
  root: { canonicalPath: project.root, dev: '1', ino: '2' },
  purpose: 'human-interaction',
  conversationId: '11111111-1111-1111-1111-111111111111',
  generation: 1,
  status: 'active',
  predecessorGeneration: null,
  creationMode: 'created',
  provenanceDigest: 'a'.repeat(64),
  createdAt: now,
  updatedAt: now,
  retiredAt: null,
  recordDigest: 'b'.repeat(64),
} as ProjectHumanThreadBinding;

function message(overrides: Partial<ProjectHumanThreadMessage> = {}): ProjectHumanThreadMessage {
  const base = {
    schemaVersion: 'roadex.project-human-thread-message.v1' as const,
    messageId: 'question-1',
    projectId: project.id,
    conversationId: binding.conversationId,
    generation: 1,
    kind: 'question' as const,
    content: 'Do you want to deploy and test this app?',
    choices: [],
    correlationId: 'corr-1',
    idempotencyKey: 'question-key-1',
    occurredAt: now,
    ...overrides,
  };
  const withoutDigest = { ...base, contentDigest: messageDigest.content(base.content) };
  return { ...withoutDigest, messageDigest: messageDigest.record(withoutDigest) };
}

function setup(current: () => ProjectHumanThreadBinding | undefined = () => binding, path = join(mkdtempSync(join(tmpdir(), 'roadex-transcript-')), 'transcript.sqlite')) {
  const store = new ProjectHumanThreadTranscriptStore(current, { databasePath: path, now: () => now });
  return { store, path };
}

function request(messageValue = message(), nonce = 'question-nonce-1') {
  const body = questionStableJson({ schemaVersion: 'overseer.project-human-thread-question.v1', message: messageValue });
  const timestamp = now;
  const signature = createHmac('sha256', secret).update([PROJECT_HUMAN_THREAD_QUESTION_REQUEST_DOMAIN, timestamp, nonce, questionSha256(body)].join('\n')).digest('hex');
  return { body, headers: {
    'x-overseer-question-timestamp': timestamp,
    'x-overseer-question-nonce': nonce,
    'x-overseer-question-signature': signature,
  } };
}

describe('project human thread transcript', () => {
  it('persists authenticated questions, rejects stale generation, and replays a nonce', () => {
    const { store } = setup();
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-1' });
    const first = request();
    expect(receiver.receive(first.body, first.headers).status).toBe(202);
    expect(receiver.receive(first.body, first.headers).status).toBe(202);
    expect(store.pending(project.id)).toHaveLength(1);
    const stale = request(message({ generation: 2 }));
    expect(receiver.receive(stale.body, stale.headers).status).toBe(409);
    store.close();
  });

  it('recovers a receipt after a crash between question commit and receipt commit', () => {
    let currentNow = now;
    const { store } = setup(() => binding);
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => currentNow, createNonce: () => 'receipt-crash-recovery' });
    const incoming = request();
    store.receiveQuestion(message(), incoming.headers['x-overseer-question-nonce'], incoming.headers['x-overseer-question-timestamp']);
    currentNow = '2026-08-22T13:10:00.000Z';
    expect(receiver.receive(incoming.body, incoming.headers).status).toBe(202);
    expect(store.receipt(incoming.headers['x-overseer-question-nonce'])).toBeDefined();
    store.close();
  });

  it('rejects invalid HMAC and nonce reuse with a different message', () => {
    const { store } = setup();
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-1' });
    const first = request();
    expect(receiver.receive(first.body, { ...first.headers, 'x-overseer-question-signature': '0'.repeat(64) }).status).toBe(401);
    expect(receiver.receive(first.body, first.headers).status).toBe(202);
    const changed = request(message({ messageId: 'question-2', content: 'Choose another option.' }));
    expect(receiver.receive(changed.body, { ...changed.headers, 'x-overseer-question-nonce': first.headers['x-overseer-question-nonce'] }).status).toBe(409);
    store.close();
  });

  it('returns a separately signed durable receipt with exact request binding', () => {
    const { store } = setup();
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-exact' });
    const incoming = request();
    const response = receiver.receive(incoming.body, incoming.headers);
    expect(response.status).toBe(202);
    const receipt = parseProjectHumanThreadQuestionReceipt(JSON.parse(response.body));
    expect(receipt).toMatchObject({
      messageId: 'question-1',
      requestNonce: incoming.headers['x-overseer-question-nonce'],
      receiptNonce: 'receipt-exact',
    });
    const expected = createHmac('sha256', secret).update([
      PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_DOMAIN,
      response.headers['x-roadex-question-timestamp'],
      receipt.requestNonce,
      questionSha256(response.body),
    ].join('\n')).digest('hex');
    expect(response.headers['x-roadex-question-signature']).toBe(expected);
    store.close();
  });

  it('submits one owner-bound ordinary response and preserves the outbox across rebuild', () => {
    const { store } = setup();
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-1' });
    const incoming = request();
    receiver.receive(incoming.body, incoming.headers);
    const controller = new ProjectHumanThreadTranscriptController(store, { resolveOwnedProject: (user, projectId) => user.id === owner.id && projectId === project.id ? { projectId: project.id } : undefined });
    const submitted = controller.submit(owner, project.id, 'question-1', 'response-key-1', { content: 'Yes, deploy and test it.' });
    expect(submitted).toMatchObject({ messageId: 'question-1', content: 'Yes, deploy and test it.' });
    expect(controller.pending(owner, project.id)).toHaveLength(0);
    expect(controller.history(owner, project.id)[0]).toMatchObject({ state: 'answered', response: submitted });
    expect(store.pendingResponseOutbox()).toHaveLength(1);
    store.rebuild();
    expect(store.history(project.id)[0].response?.content).toBe('Yes, deploy and test it.');
    expect(store.pendingResponseOutbox()).toHaveLength(1);
    store.markResponseOutboxDelivered(store.pendingResponseOutbox()[0].eventId);
    expect(store.pendingResponseOutbox()).toHaveLength(0);
    store.close();
  });

  it('fences responses to the current generation and prevents changed retries', () => {
    let current: ProjectHumanThreadBinding | undefined = binding;
    const { store } = setup(() => current);
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-1' });
    const incoming = request();
    receiver.receive(incoming.body, incoming.headers);
    const controller = new ProjectHumanThreadTranscriptController(store, { resolveOwnedProject: () => ({ projectId: project.id }) });
    controller.submit(owner, project.id, 'question-1', 'response-key-1', { content: 'First response.' });
    expect(() => controller.submit(owner, project.id, 'question-1', 'response-key-2', { content: 'Different response.' })).toThrow(/conflict/i);
    current = { ...binding, generation: 2, bindingId: 'project-human-thread:arcade:2', predecessorGeneration: 1, conversationId: '22222222-2222-2222-2222-222222222222' };
    expect(() => controller.submit(owner, project.id, 'question-1', 'response-key-1', { content: 'First response.' })).toThrow(/generation conflict/i);
    store.close();
  });

  it('keeps bounded event and response identifiers for maximum-length message ids', () => {
    const { store } = setup();
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-1' });
    const longMessage = message({ messageId: `m${'x'.repeat(159)}` });
    const incoming = request(longMessage, 'question-nonce-long');
    expect(receiver.receive(incoming.body, incoming.headers).status).toBe(202);
    const controller = new ProjectHumanThreadTranscriptController(store, { resolveOwnedProject: () => ({ projectId: project.id }) });
    const response = controller.submit(owner, project.id, longMessage.messageId, 'response-key-long', { content: 'Acknowledged.' });
    expect(response.responseId.length).toBeLessThanOrEqual(160);
    expect(store.pendingResponseOutbox()[0].eventId.length).toBeLessThanOrEqual(160);
    store.close();
  });

  it('enforces bounded-choice responses and blocks informational notices', () => {
    const { store } = setup();
    const receiver = new ProjectHumanThreadQuestionReceiver(store, { secret, now: () => now, createNonce: () => 'receipt-1' });
    const choice = message({ messageId: 'question-choice', kind: 'bounded-choice', content: 'Choose a deployment path.', choices: ['Deploy', 'Wait'] });
    const incomingChoice = request(choice, 'question-nonce-choice');
    receiver.receive(incomingChoice.body, incomingChoice.headers);
    const notice = message({ messageId: 'question-notice', kind: 'informational-notice', content: 'Deployment is paused.', choices: [] });
    const incomingNotice = request(notice, 'question-nonce-notice');
    receiver.receive(incomingNotice.body, incomingNotice.headers);
    const controller = new ProjectHumanThreadTranscriptController(store, { resolveOwnedProject: () => ({ projectId: project.id }) });
    expect(() => controller.submit(owner, project.id, choice.messageId, 'choice-bad', { content: 'Deploy now' })).toThrow(/advertised choice/i);
    expect(controller.submit(owner, project.id, choice.messageId, 'choice-good', { content: 'Deploy' }).content).toBe('Deploy');
    expect(() => controller.submit(owner, project.id, notice.messageId, 'notice-response', { content: 'Okay' })).toThrow(/informational notices/i);
    store.close();
  });
});
