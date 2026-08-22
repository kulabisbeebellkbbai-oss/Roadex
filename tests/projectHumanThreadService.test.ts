import { describe, expect, it, vi } from 'vitest';
import type { ProjectHumanThreadCandidate } from '../src/server/projectHumanThreadAuthority';
import { ProjectHumanThreadService } from '../src/server/projectHumanThreadService';
import { ProjectHumanThreadStore } from '../src/server/projectHumanThreadStore';

const root = '/workspace/Arcade';
const first: ProjectHumanThreadCandidate = {
  conversationId: '01a01569-7874-7f72-bca9-9c91bb869846',
  canonicalPath: root, dev: '254', ino: '12345', createdAt: 1,
};
const second: ProjectHumanThreadCandidate = {
  ...first, conversationId: '01a01569-7874-7f72-bca9-9c91bb869847', createdAt: 2,
};

class FakeAuthority {
  available: ProjectHumanThreadCandidate[] = [];
  created: ProjectHumanThreadCandidate[] = [];
  candidates(projectRoot: string) { return projectRoot === root ? [...this.available] : []; }
  inspect(projectRoot: string, conversationId: string) {
    const value = this.available.find((item) => item.conversationId === conversationId);
    if (!value || projectRoot !== root) throw new Error('unavailable');
    return value;
  }
  async create(projectRoot: string) {
    if (projectRoot !== root) throw new Error('wrong root');
    const value = this.created.shift();
    if (!value) throw new Error('no controlled candidate');
    this.available.push(value);
    return value;
  }
  repair(binding: { conversationId: string }) {
    return this.inspect(root, binding.conversationId);
  }
}

function setup() {
  const store = new ProjectHumanThreadStore(':memory:');
  const authority = new FakeAuthority();
  const service = new ProjectHumanThreadService(store, authority, {
    now: () => '2026-08-22T12:00:00.000Z',
  });
  return { store, authority, service };
}

const request = {
  projectId: 'arcade', projectRoot: root,
  provenanceDigest: '1'.repeat(64), idempotencyKey: 'human-thread:arcade:create-1',
};

describe('ProjectHumanThreadService', () => {
  it('creates a missing thread once and returns the exact binding on retry', async () => {
    const { authority, service } = setup();
    authority.created.push(first);
    const created = await service.createMissing(request);
    const replay = await service.createMissing(request);
    expect(created).toMatchObject({ outcome: 'created', binding: { projectId: 'arcade', generation: 1, conversationId: first.conversationId } });
    expect(replay).toEqual({ outcome: 'current', binding: created.binding });
  });

  it('requires explicit adoption when any candidate exists', async () => {
    const { authority, service } = setup();
    authority.available.push(first, second);
    await expect(service.createMissing(request)).resolves.toEqual({
      outcome: 'adoption-required',
      candidates: [first, second],
    });
    await expect(service.adopt({ ...request, conversationId: first.conversationId })).resolves.toMatchObject({
      outcome: 'adopted', binding: { creationMode: 'adopted', conversationId: first.conversationId },
    });
  });

  it('recovers the same identity or marks the binding unavailable', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first);
    const created = await service.createMissing(request);
    if (!('binding' in created)) throw new Error('binding missing');
    expect(service.recover('arcade', 1, 'recover:arcade:1')).toEqual({ outcome: 'recovered', binding: created.binding });
    authority.available.length = 0;
    expect(service.recover('arcade', 1, 'recover:arcade:2')).toMatchObject({ outcome: 'unavailable', binding: { status: 'unavailable' } });
    authority.available.push(first);
    const recovered = service.recover('arcade', 1, 'recover:arcade:3');
    expect(recovered).toMatchObject({ outcome: 'recovered', binding: { status: 'active', conversationId: first.conversationId } });
    store.rebuild();
    expect(service.current('arcade')).toEqual(recovered.binding);
    expect(store.pendingOutbox().at(-1)).toMatchObject({ eventId: 'recover:arcade:3', binding: { status: 'active' } });
  });

  it('replaces by generation and reuses an exact unbound candidate after a crash boundary', async () => {
    const { authority, service } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    authority.created.push(second);
    const replacement = await service.replace({
      ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered',
      idempotencyKey: 'human-thread:arcade:replace-1',
    });
    expect(replacement).toMatchObject({ outcome: 'replaced', binding: { generation: 2, conversationId: second.conversationId } });
    await expect(service.replace({
      ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered',
      idempotencyKey: 'human-thread:arcade:replace-1',
    })).resolves.toEqual({ outcome: 'current', binding: replacement.binding });
    expect(service.history('arcade')).toMatchObject([{ generation: 1, status: 'retired' }, { generation: 2, status: 'active' }]);
  });

  it('persists create intent and never spawns a second conversation after an ambiguous failure', async () => {
    const { authority, service, store } = setup();
    const create = vi.spyOn(authority, 'create').mockRejectedValue(new Error('ambiguous create'));
    await expect(service.createMissing(request)).rejects.toThrow(/ambiguous/);
    await expect(service.createMissing(request)).resolves.toEqual({ outcome: 'reconciliation-required', candidates: [] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.creationIntent('arcade')).toMatchObject({ state: 'prepared', eventId: request.idempotencyKey });
  });

  it('offers explicit adoption when an ambiguous create left one verifiable candidate', async () => {
    const { authority, service } = setup();
    vi.spyOn(authority, 'create').mockImplementation(async () => {
      authority.available.push(first);
      throw new Error('response lost');
    });
    await expect(service.createMissing(request)).rejects.toThrow(/response lost/);
    await expect(service.createMissing(request)).resolves.toEqual({ outcome: 'adoption-required', candidates: [first] });
  });

  it('does not repeat replacement creation after a prepared replacement has no candidate', async () => {
    const { authority, service } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    const create = vi.spyOn(authority, 'create').mockRejectedValue(new Error('ambiguous replacement'));
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:1' };
    await expect(service.replace(replacement)).rejects.toThrow(/ambiguous replacement/);
    await expect(service.replace(replacement)).rejects.toThrow(/requires reconciliation/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
