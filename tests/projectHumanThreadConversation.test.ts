import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserProfile } from '../src/shared/sessionContracts';
import type { ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';
import { ProjectHumanThreadConversationStore } from '../src/server/projectHumanThreadConversationStore';
import { ProjectHumanThreadConversationController } from '../src/server/projectHumanThreadConversationController';
import { ProjectHumanThreadConversationDispatcher } from '../src/server/projectHumanThreadConversationDispatcher';

const now = '2026-08-23T14:00:00.000Z';
const owner: UserProfile = { id: 'owner', displayName: 'Owner', authMode: 'mock', roles: ['user'] };
const binding: ProjectHumanThreadBinding = {
  schemaVersion: 'roadex.project-human-thread-binding.v1', bindingId: 'project-human-thread:arcade:1',
  projectId: 'arcade', root: { canonicalPath: '/srv/arcade', dev: '1', ino: '2' },
  purpose: 'human-interaction', conversationId: '11111111-1111-1111-1111-111111111111', generation: 1,
  status: 'active', predecessorGeneration: null, creationMode: 'created', provenanceDigest: 'a'.repeat(64),
  createdAt: now, updatedAt: now, retiredAt: null, recordDigest: 'b'.repeat(64),
};

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-')), 'turns.sqlite');
  const store = new ProjectHumanThreadConversationStore(() => binding, { databasePath: path, now: () => now });
  return { store, path };
}

describe('project human conversation turns', () => {
  it('queues one owner-bound turn, replays the exact idempotency key, and rejects a second active turn', () => {
    const { store } = setup();
    const first = store.enqueue(owner.id, binding, 'ping', 'turn-key-1', 'corr-1');
    expect(first.outcome).toBe('queued');
    expect(store.hasActiveTurn(binding.projectId)).toBe(true);
    expect(store.enqueue(owner.id, binding, 'ping', 'turn-key-1', 'corr-1').outcome).toBe('replayed');
    expect(() => store.enqueue(owner.id, binding, 'second', 'turn-key-2', 'corr-2')).toThrow(/already queued or running/i);
    store.close();
  });

  it('persists append-only assistant output and verifies the resumed thread identity', () => {
    const { store } = setup();
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-1', 'corr-1').turn;
    store.claim(turn.turnId);
    store.complete(turn.turnId, binding.conversationId, 'pong');
    expect(store.hasActiveTurn(binding.projectId)).toBe(false);
    expect(store.history(binding.projectId)[0]).toMatchObject({ state: 'completed', assistantOutput: 'pong' });
    expect(() => store.complete(turn.turnId, '22222222-2222-2222-2222-222222222222', 'wrong')).toThrow(/not running/i);
    store.rebuild();
    expect(store.history(binding.projectId)[0]).toMatchObject({ state: 'completed', assistantOutput: 'pong' });
    store.close();
  });

  it('marks running turns reconciliation-required on restart and never makes them retryable', () => {
    const { store, path } = setup();
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-1', 'corr-1').turn;
    store.claim(turn.turnId);
    store.close();
    const reopened = new ProjectHumanThreadConversationStore(() => binding, { databasePath: path, now: () => now });
    expect(reopened.history(binding.projectId)[0]).toMatchObject({ state: 'reconciliation-required' });
    expect(reopened.pendingOutbox()).toEqual([]);
    reopened.close();
  });

  it('requires exact owner, active current binding, and strict turn body', async () => {
    const { store } = setup();
    const controller = new ProjectHumanThreadConversationController(store, {
      resolveOwnedProject: (user, projectId) => user.id === owner.id && projectId === 'arcade' ? { projectId } : undefined,
    }, () => binding);
    await expect(controller.read(owner, 'arcade')).resolves.toMatchObject({ conversationId: binding.conversationId, turns: [] });
    await expect(controller.enqueue(owner, 'arcade', 'turn-key-2', { content: 'ping', correlationId: 'corr-2' })).resolves.toMatchObject({ state: 'queued' });
    await expect(controller.enqueue({ ...owner, id: 'other' }, 'arcade', 'turn-key-3', { content: 'ping', correlationId: 'corr-3' })).rejects.toThrow(/not found/i);
    await expect(controller.enqueue(owner, 'arcade', 'turn-key-4', { content: 'ping', correlationId: 'corr-4', approved: true })).rejects.toThrow(/invalid/i);
    store.close();
  });

  it('projects only the current binding generation after replacement', async () => {
    let current = binding;
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-generation-')), 'turns.sqlite');
    const store = new ProjectHumanThreadConversationStore(() => current, { databasePath: path, now: () => now });
    const old = store.enqueue(owner.id, binding, 'old message', 'old-turn-key', 'old-corr').turn;
    store.claim(old.turnId);
    store.complete(old.turnId, binding.conversationId, 'old answer');
    current = {
      ...binding,
      bindingId: 'project-human-thread:arcade:2',
      conversationId: '22222222-2222-2222-2222-222222222222',
      generation: 2,
      predecessorGeneration: 1,
    };
    const controller = new ProjectHumanThreadConversationController(store, {
      resolveOwnedProject: () => ({ projectId: binding.projectId }),
    }, () => current);
    await expect(controller.read(owner, binding.projectId)).resolves.toMatchObject({
      conversationId: current.conversationId,
      generation: 2,
      turns: [],
    });
    store.close();
  });

  it('dispatches only when the exact tmux locator is not live and persists the exact returned thread id', async () => {
    const { store } = setup();
    const calls: string[][] = [];
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => binding,
      hasLiveLocator: () => false,
    }, {
      spawnProcess: (_executable, args) => {
        calls.push(args);
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        queueMicrotask(() => {
          child.stdout.emit('data', '{"thread_id":"11111111-1111-1111-1111-111111111111","type":"assistant_message","message":"pong"}\n');
          child.exitCode = 0; child.emit('close', 0);
        });
        return child as never;
      },
      now: () => now,
      executable: '/codex',
    });
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-1', 'corr-1').turn;
    await expect(dispatcher.dispatch(turn.turnId)).resolves.toMatchObject({ state: 'completed', assistantOutput: 'pong' });
    expect(calls[0]).toEqual(expect.arrayContaining(['exec', '--json', 'resume', binding.conversationId, 'ping']));
    store.close();
  });

  it('durably fails with reconciliation-required when the exact locator is live', async () => {
    const { store } = setup();
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => binding,
      hasLiveLocator: () => true,
      spawnProcess: () => { throw new Error('must not spawn'); },
      now: () => now,
    });
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-1', 'corr-1').turn;
    await expect(dispatcher.dispatch(turn.turnId)).rejects.toThrow(/reconciliation-required/i);
    expect(store.history(binding.projectId)[0]).toMatchObject({ state: 'reconciliation-required' });
    store.close();
  });

  it('stores a stable public failure instead of raw noisy Codex stderr', async () => {
    const { store } = setup();
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => binding,
      hasLiveLocator: () => false,
    }, {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => boolean };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.kill = () => true;
        queueMicrotask(() => {
          child.stderr.emit('data', `secret-local-path-${'x'.repeat(2_000)}`);
          child.exitCode = 1; child.emit('close', 1);
        });
        return child as never;
      },
      executable: '/codex',
    });
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-noisy', 'corr-noisy').turn;
    await expect(dispatcher.dispatch(turn.turnId)).rejects.toThrow(/reconciliation-required/i);
    expect(store.get(turn.turnId)?.error).toBe('Codex conversation dispatch failed; inspect the private server audit before retrying.');
    expect(store.get(turn.turnId)?.error).not.toContain('secret-local-path');
    store.close();
  });
});
