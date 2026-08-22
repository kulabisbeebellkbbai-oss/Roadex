import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageDigest, type ProjectHumanThreadMessage } from '../src/shared/projectHumanThreadContracts';
import { ProjectHumanThreadRelay, ProjectHumanThreadRelayCoordinator, relayStableJson, relaySha256 } from '../src/server/projectHumanThreadRelay';
import { ProjectHumanThreadStore } from '../src/server/projectHumanThreadStore';
import { bindingDigest, type ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';

const directories: string[] = [];
const secret = 'roadex-overseer-project-thread-relay-secret-32';
const messageBase = {
  schemaVersion: 'roadex.project-human-thread-message.v1' as const,
  messageId: 'human-message-1',
  projectId: 'arcade',
  conversationId: '019fc36f-0570-7623-912f-6da8181eda2d',
  generation: 1,
  kind: 'question' as const,
  content: 'Do you want to deploy and test the app?',
  choices: [],
  contentDigest: messageDigest.content('Do you want to deploy and test the app?'),
  correlationId: 'correlation-1',
  idempotencyKey: 'message-key-1',
  occurredAt: '2026-08-22T12:00:00.000Z',
};
const message: ProjectHumanThreadMessage = { ...messageBase, messageDigest: messageDigest.record(messageBase) };

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'roadex-project-thread-relay-'));
  directories.push(directory);
  return join(directory, 'relay.sqlite');
}

function accepted(body: string, headers: Record<string, string>) {
  const request = JSON.parse(body) as Record<string, unknown>;
  const occurredAt = '2026-08-22T12:00:01.000Z';
  const receipt = {
    schemaVersion: 'overseer.roadex.project-human-thread-relay-receipt.v1',
    accepted: true,
    recordType: request.recordType,
    recordId: request.recordId,
    recordDigest: request.recordDigest,
    requestNonce: headers['x-roadex-relay-nonce'],
    receiptNonce: 'receipt-nonce-0001',
    occurredAt,
  };
  const responseBody = relayStableJson(receipt);
  return {
    status: 202,
    body: responseBody,
    headers: {
      'x-overseer-relay-timestamp': occurredAt,
      'x-overseer-relay-signature': createHmac('sha256', secret).update([
        'overseer.roadex.project-human-thread-relay.receipt.v1',
        occurredAt,
        headers['x-roadex-relay-nonce'],
        relaySha256(responseBody),
      ].join('\n')).digest('hex'),
    },
  };
}

describe('ProjectHumanThreadRelay', () => {
  it('persists an exact message before send and marks only an authenticated receipt delivered', async () => {
    const send = vi.fn(async (body: string, headers: Record<string, string>) => accepted(body, headers));
    const relay = new ProjectHumanThreadRelay({ databasePath: database(), secret, send,
      now: () => '2026-08-22T12:00:00.000Z', createNonce: () => 'request-nonce-0001' });
    expect(relay.enqueueMessage(message)).toMatchObject({ state: 'pending' });
    expect(await relay.deliver(message.messageId)).toMatchObject({ state: 'delivered' });
    expect(send).toHaveBeenCalledTimes(1);
    const [body, headers] = send.mock.calls[0];
    expect(JSON.parse(body)).toEqual({
      schemaVersion: 'roadex.overseer.project-human-thread-relay.v1',
      recordType: 'message', recordId: message.messageId, recordDigest: message.messageDigest, record: message,
    });
    expect(headers['x-roadex-relay-signature']).toMatch(/^[a-f0-9]{64}$/);
    relay.close();
  });

  it('replays the byte-identical request after a lost response and restart', async () => {
    const path = database();
    const calls: Array<[string, Record<string, string>]> = [];
    const first = new ProjectHumanThreadRelay({ databasePath: path, secret,
      now: () => '2026-08-22T12:00:00.000Z', createNonce: () => 'request-nonce-0002',
      send: async (body, headers) => { calls.push([body, headers]); throw new Error('lost response'); } });
    first.enqueueMessage(message);
    await expect(first.deliver(message.messageId)).rejects.toThrow(/lost response/);
    first.close();
    const second = new ProjectHumanThreadRelay({ databasePath: path, secret,
      send: async (body, headers) => { calls.push([body, headers]); return accepted(body, headers); } });
    await second.retryPending();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    second.close();
  });

  it('rejects conflicting replay, approval-shaped records, receipt substitution, and nonce reuse', async () => {
    const relay = new ProjectHumanThreadRelay({ databasePath: database(), secret,
      now: () => '2026-08-22T12:00:00.000Z', createNonce: () => 'request-nonce-0003',
      send: async (body, headers) => {
        const response = accepted(body, headers);
        const parsed = JSON.parse(response.body);
        parsed.recordId = 'admin-plan-1';
        return { ...response, body: JSON.stringify(parsed) };
      } });
    relay.enqueueMessage(message);
    expect(() => relay.enqueueMessage({ ...message, content: 'approved' } as ProjectHumanThreadMessage)).toThrow();
    expect(() => relay.enqueue('message', { ...message, approved: true } as never)).toThrow();
    await expect(relay.deliver(message.messageId)).rejects.toThrow(/receipt/i);
    relay.close();
  });

  it('allows one concurrent sender while retaining at-least-once restart recovery', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(async (body: string, headers: Record<string, string>) => { await wait; return accepted(body, headers); });
    const relay = new ProjectHumanThreadRelay({ databasePath: database(), secret, send,
      now: () => '2026-08-22T12:00:00.000Z', createNonce: () => 'request-nonce-0004' });
    relay.enqueueMessage(message);
    const first = relay.deliver(message.messageId);
    await expect(relay.deliver(message.messageId)).rejects.toThrow(/claimed/i);
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    relay.close();
  });

  it('does not let a second process instance steal a live durable claim', async () => {
    const path = database();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = new ProjectHumanThreadRelay({ databasePath: path, secret,
      now: () => '2026-08-22T12:00:00.000Z', createNonce: () => 'request-nonce-0005',
      send: async (body, headers) => { await wait; return accepted(body, headers); } });
    first.enqueueMessage(message);
    const delivery = first.deliver(message.messageId);
    const second = new ProjectHumanThreadRelay({ databasePath: path, secret,
      now: () => '2026-08-22T12:00:01.000Z', send: async (body, headers) => accepted(body, headers) });
    await expect(second.deliver(message.messageId)).rejects.toThrow(/claimed/i);
    second.close();
    release(); await delivery; first.close();
  });

  it('rejects a receipt nonce reused for a different durable record', async () => {
    const send = vi.fn(async (body: string, headers: Record<string, string>) => accepted(body, headers));
    let nonce = 0;
    const relay = new ProjectHumanThreadRelay({ databasePath: database(), secret, send,
      now: () => '2026-08-22T12:00:00.000Z', createNonce: () => `request-nonce-000${++nonce}` });
    relay.enqueueMessage(message);
    await relay.deliver(message.messageId);
    const secondBase = { ...messageBase, messageId: 'human-message-2', idempotencyKey: 'message-key-2' };
    const second = { ...secondBase, messageDigest: messageDigest.record(secondBase) };
    relay.enqueueMessage(second);
    await expect(relay.deliver(second.messageId)).rejects.toThrow();
    relay.close();
  });

  it('revalidates a stored delivered receipt before exact replay', async () => {
    const path = database();
    const relay = new ProjectHumanThreadRelay({ databasePath: path, secret,
      now: () => message.occurredAt, createNonce: () => 'request-nonce-0010',
      send: async (body, headers) => accepted(body, headers) });
    relay.enqueueMessage(message); await relay.deliver(message.messageId); relay.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE project_human_thread_relay_receipts SET receipt_body='{}' WHERE record_id=?").run(message.messageId);
    db.close();
    const reopened = new ProjectHumanThreadRelay({ databasePath: path, secret,
      send: async (body, headers) => accepted(body, headers) });
    await expect(reopened.deliver(message.messageId)).rejects.toThrow(/stored receipt/i);
    reopened.close();
  });

  it('delivers binding lifecycle events from the transactional store outbox', async () => {
    const store = new ProjectHumanThreadStore(':memory:');
    const value = {
      schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
      bindingId: 'project-human-thread:arcade:1', projectId: 'arcade',
      root: { canonicalPath: '/srv/arcade', dev: '1', ino: '2' }, purpose: 'human-interaction' as const,
      conversationId: message.conversationId, generation: 1, status: 'active' as const,
      predecessorGeneration: null, creationMode: 'created' as const, provenanceDigest: 'a'.repeat(64),
      createdAt: message.occurredAt, updatedAt: message.occurredAt, retiredAt: null,
    };
    const binding: ProjectHumanThreadBinding = { ...value, recordDigest: bindingDigest(value) };
    store.createInitial(binding, 'create:arcade:1');
    const relay = new ProjectHumanThreadRelay({ databasePath: database(), secret,
      now: () => message.occurredAt, createNonce: () => 'request-nonce-0009',
      send: async (body, headers) => accepted(body, headers) });
    expect(await new ProjectHumanThreadRelayCoordinator(store, relay).retryBindings()).toEqual({ delivered: 1, failed: 0 });
    expect(store.pendingOutbox()).toEqual([]);
    relay.close(); store.close();
  });
});
