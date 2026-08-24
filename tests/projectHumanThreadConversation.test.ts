import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserProfile } from '../src/shared/sessionContracts';
import { bindingDigest, type ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';
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

function runtimeBinding(): ProjectHumanThreadBinding {
  const canonicalPath = mkdtempSync(join(tmpdir(), 'roadex-human-writer-root-'));
  const stat = lstatSync(canonicalPath);
  const value = {
    ...binding,
    root: { canonicalPath, dev: String(stat.dev), ino: String(stat.ino) },
  };
  const withoutDigest = { ...value };
  delete (withoutDigest as Partial<ProjectHumanThreadBinding>).recordDigest;
  return { ...withoutDigest, recordDigest: bindingDigest(withoutDigest) };
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
    const activeBinding = runtimeBinding();
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-')), 'turns.sqlite');
    const store = new ProjectHumanThreadConversationStore(() => activeBinding, { databasePath: path, now: () => now });
    const calls: string[][] = [];
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => activeBinding,
      hasLiveLocator: () => false,
    }, {
      spawnProcess: (executable, args, options) => {
        expect(executable).toBe('/usr/bin/python3');
        expect(args.slice(0, 3)).toEqual(['-I', '-S', '-c']);
        expect(args).toEqual(expect.arrayContaining(['/codex', 'exec', '--json', 'resume', activeBinding.conversationId, 'ping']));
        expect(Array.isArray(options?.stdio)).toBe(true);
        expect((options?.stdio as unknown[])[3]).toEqual(expect.any(Number));
        calls.push(args);
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => boolean; end: () => void }; exitCode: number | null; pid: number };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write: () => true, end: () => undefined }; child.exitCode = null; child.pid = process.pid;
        queueMicrotask(() => {
          child.stdout.emit('data', '{"thread_id":"11111111-1111-1111-1111-111111111111","type":"assistant_message","message":"pong"}\n');
          child.exitCode = 0; child.emit('close', 0);
        });
        return child as never;
      },
      now: () => now,
      executable: '/codex',
    });
    const turn = store.enqueue(owner.id, activeBinding, 'ping', 'turn-key-1', 'corr-1').turn;
    await expect(dispatcher.dispatch(turn.turnId)).resolves.toMatchObject({ state: 'completed', assistantOutput: 'pong' });
    expect(calls[0]).toEqual(expect.arrayContaining(['exec', '--json', 'resume', activeBinding.conversationId, 'ping']));
    store.close();
  });

  it('uses an absolute Codex executable with the execv writer wrapper by default', async () => {
    const activeBinding = runtimeBinding();
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-')), 'turns.sqlite');
    const store = new ProjectHumanThreadConversationStore(() => activeBinding, { databasePath: path, now: () => now });
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => activeBinding,
      hasLiveLocator: () => false,
    }, {
      spawnProcess: (_executable, args) => {
        expect(args[4]).toBe('/home/god/.local/bin/codex');
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => boolean; end: () => void }; exitCode: number | null; pid: number };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write: () => true, end: () => undefined }; child.exitCode = null; child.pid = process.pid;
        queueMicrotask(() => {
          child.stdout.emit('data', `{"thread_id":"${activeBinding.conversationId}","type":"assistant_message","message":"pong"}\n`);
          child.exitCode = 0; child.emit('close', 0);
        });
        return child as never;
      },
    });
    const turn = store.enqueue(owner.id, activeBinding, 'ping', 'turn-key-default-codex', 'corr-default-codex').turn;

    await expect(dispatcher.dispatch(turn.turnId)).resolves.toMatchObject({ state: 'completed' });
    store.close();
  });

  it('hands the exact live locator to Roadex before dispatching the same conversation', async () => {
    const activeBinding = runtimeBinding();
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-')), 'turns.sqlite');
    const store = new ProjectHumanThreadConversationStore(() => activeBinding, { databasePath: path, now: () => now });
    let live = true;
    const handoffs: ProjectHumanThreadBinding[] = [];
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => activeBinding,
      hasLiveLocator: () => live,
      handoffToRoadex: (value) => { handoffs.push(value); live = false; },
    }, {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => boolean; end: () => void }; exitCode: number | null; pid: number };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write: () => true, end: () => undefined }; child.exitCode = null; child.pid = process.pid;
        queueMicrotask(() => {
          child.stdout.emit('data', `{"thread_id":"${activeBinding.conversationId}","type":"assistant_message","message":"pong"}\n`);
          child.exitCode = 0; child.emit('close', 0);
        });
        return child as never;
      },
      executable: '/codex',
    });
    const turn = store.enqueue(owner.id, activeBinding, 'ping', 'turn-key-1', 'corr-1').turn;
    await expect(dispatcher.dispatch(turn.turnId)).resolves.toMatchObject({ state: 'completed', assistantOutput: 'pong' });
    expect(handoffs).toEqual([activeBinding]);
    store.close();
  });

  it('requeues only a never-dispatched live-writer conflict for crash-safe same-thread handoff', () => {
    const { store } = setup();
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-handoff', 'corr-handoff').turn;
    store.fail(turn.turnId, 'A live writer already owns the exact project-thread locator. Use controlled handoff or Replace binding; Roadex will not terminate it or create a second writer.', true);

    expect(store.requeueHandoffRequired()).toEqual([expect.objectContaining({
      turnId: turn.turnId,
      state: 'queued',
      writerHandoff: 'required',
    })]);
    expect(store.pendingOutbox()).toEqual([expect.objectContaining({ turnId: turn.turnId })]);
    expect(store.requeueHandoffRequired()).toEqual([]);
    store.rebuild();
    expect(store.get(turn.turnId)).toMatchObject({ state: 'queued', writerHandoff: 'required' });
    store.close();
  });

  it('records a later handoff failure after recovering a legacy reconciliation event', async () => {
    const { store } = setup();
    const turn = store.enqueue(owner.id, binding, 'ping', 'turn-key-handoff-failure', 'corr-handoff-failure').turn;
    store.fail(turn.turnId, 'A live writer already owns the exact project-thread locator. Use controlled handoff or Replace binding; Roadex will not terminate it or create a second writer.', true);
    store.requeueHandoffRequired();
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => binding,
      hasLiveLocator: () => true,
      handoffToRoadex: () => { throw new Error('retirement unavailable'); },
    });

    await expect(dispatcher.dispatch(turn.turnId)).rejects.toThrow(/reconciliation-required/i);
    expect(store.get(turn.turnId)).toMatchObject({
      state: 'reconciliation-required',
      writerHandoff: 'required',
      error: 'Controlled same-thread writer handoff could not be verified; manual reconciliation is required.',
    });
    expect(store.pendingOutbox()).toEqual([]);
    expect(store.requeueHandoffRequired()).toEqual([expect.objectContaining({
      turnId: turn.turnId,
      state: 'queued',
      writerHandoff: 'required',
    })]);
    store.close();
  });

  it('stores a stable public failure instead of raw noisy Codex stderr', async () => {
    const activeBinding = runtimeBinding();
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-')), 'turns.sqlite');
    const store = new ProjectHumanThreadConversationStore(() => activeBinding, { databasePath: path, now: () => now });
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, {
      current: () => activeBinding,
      hasLiveLocator: () => false,
    }, {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => boolean; end: () => void }; exitCode: number | null; pid: number; kill: () => boolean };
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write: () => true, end: () => undefined }; child.exitCode = null; child.pid = process.pid; child.kill = () => true;
        queueMicrotask(() => {
          child.stderr.emit('data', `secret-local-path-${'x'.repeat(2_000)}`);
          child.exitCode = 1; child.emit('close', 1);
        });
        return child as never;
      },
      executable: '/codex',
    });
    const turn = store.enqueue(owner.id, activeBinding, 'ping', 'turn-key-noisy', 'corr-noisy').turn;
    await expect(dispatcher.dispatch(turn.turnId)).rejects.toThrow(/reconciliation-required/i);
    expect(store.get(turn.turnId)?.error).toBe('Codex conversation dispatch failed; inspect the private server audit before retrying.');
    expect(store.get(turn.turnId)?.error).not.toContain('secret-local-path');
    store.close();
  });

  it('terminates and awaits every owned writer before shutdown completes', async () => {
    const activeBinding = runtimeBinding();
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-human-turn-')), 'turns.sqlite');
    const store = new ProjectHumanThreadConversationStore(() => activeBinding, { databasePath: path, now: () => now });
    let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => boolean; end: () => void }; exitCode: number | null; pid: number; kill: (signal?: NodeJS.Signals) => boolean };
    const dispatcher = new ProjectHumanThreadConversationDispatcher(store, { current: () => activeBinding, hasLiveLocator: () => false }, {
      spawnProcess: () => {
        child = new EventEmitter() as typeof child;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write: () => true, end: () => undefined };
        child.exitCode = null; child.pid = process.pid;
        child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
        return child as never;
      },
      executable: '/codex',
    });
    const turn = store.enqueue(owner.id, activeBinding, 'ping', 'turn-key-shutdown', 'corr-shutdown').turn;
    const dispatch = dispatcher.dispatch(turn.turnId).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(dispatcher.shutdown()).resolves.toBeUndefined();
    await dispatch;
    expect(store.get(turn.turnId)?.state).toBe('reconciliation-required');
    await expect(dispatcher.dispatchPending()).resolves.toEqual({ completed: 0, failed: 0 });
    store.close();
  });
});
