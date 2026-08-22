import { describe, expect, it } from 'vitest';
import {
  bindingDigest,
  messageDigest,
  parseProjectHumanThreadBinding,
  parseProjectHumanThreadMessage,
  parseProjectHumanThreadResponse,
  responseDigest,
} from '../src/shared/projectHumanThreadContracts';

const bindingBase = {
  schemaVersion: 'roadex.project-human-thread-binding.v1',
  bindingId: 'project-human-thread:arcade:1',
  projectId: 'arcade',
  root: { canonicalPath: '/home/god/Documents/Codex Workspace/Arcade', dev: '254', ino: '12345' },
  purpose: 'human-interaction',
  conversationId: '01a01569-7874-7f72-bca9-9c91bb869846',
  generation: 1,
  status: 'active',
  predecessorGeneration: null,
  creationMode: 'created',
  provenanceDigest: '1'.repeat(64),
  createdAt: '2026-08-22T12:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
  retiredAt: null,
} as const;

const messageBase = {
  schemaVersion: 'roadex.project-human-thread-message.v1',
  messageId: 'project-human-message:arcade:deploy-1',
  projectId: 'arcade',
  conversationId: bindingBase.conversationId,
  generation: 1,
  kind: 'bounded-choice',
  content: 'Do you want to deploy and test the app?',
  choices: ['yes', 'no'],
  contentDigest: '',
  correlationId: 'corr-arcade-deploy-1',
  idempotencyKey: 'human-message:arcade:deploy-1',
  occurredAt: '2026-08-22T12:01:00.000Z',
} as const;

describe('project human thread contracts', () => {
  it('parses an exact canonical binding and recomputes its digest', () => {
    const value = { ...bindingBase, recordDigest: bindingDigest(bindingBase) };
    expect(parseProjectHumanThreadBinding(value)).toEqual(value);
  });

  it('rejects unknown fields, transformed identifiers, invalid lineage, and digest substitution', () => {
    const valid = { ...bindingBase, recordDigest: bindingDigest(bindingBase) };
    for (const candidate of [
      { ...valid, secret: 'no' },
      { ...valid, projectId: ' arcade ' },
      { ...valid, conversationId: 'thread-short' },
      { ...valid, predecessorGeneration: 1 },
      { ...valid, recordDigest: '0'.repeat(64) },
    ]) expect(() => parseProjectHumanThreadBinding(candidate)).toThrow();
  });

  it('binds messages and responses to the exact project, conversation, and generation', () => {
    const contentDigest = messageDigest.content(messageBase.content);
    const messageWithoutDigest = { ...messageBase, contentDigest };
    const message = { ...messageWithoutDigest, messageDigest: messageDigest.record(messageWithoutDigest) };
    expect(parseProjectHumanThreadMessage(message)).toEqual(message);

    const responseWithoutDigest = {
      schemaVersion: 'roadex.project-human-thread-response.v1',
      responseId: 'project-human-response:arcade:deploy-1',
      messageId: message.messageId,
      projectId: message.projectId,
      conversationId: message.conversationId,
      generation: message.generation,
      content: 'yes',
      contentDigest: responseDigest.content('yes'),
      correlationId: message.correlationId,
      idempotencyKey: 'human-response:arcade:deploy-1',
      occurredAt: '2026-08-22T12:02:00.000Z',
    } as const;
    const response = { ...responseWithoutDigest, responseDigest: responseDigest.record(responseWithoutDigest) };
    expect(parseProjectHumanThreadResponse(response)).toEqual(response);
    expect(() => parseProjectHumanThreadResponse({ ...response, generation: 2 })).toThrow();
  });
});
