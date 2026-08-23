import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  proven: ProjectHumanThreadCandidate[] = [];
  created: ProjectHumanThreadCandidate[] = [];
  receipts = new Map<string, ProjectHumanThreadCandidate>();
  preparedReplacements: string[] = [];
  candidates(projectRoot: string) { return projectRoot === root ? [...this.available] : []; }
  adoptableCandidates(projectRoot: string) { return projectRoot === root ? [...this.proven] : []; }
  inspect(projectRoot: string, conversationId: string) {
    const value = this.available.find((item) => item.conversationId === conversationId);
    if (!value || projectRoot !== root) throw new Error('unavailable');
    return value;
  }
  inspectAdoptable(projectRoot: string, conversationId: string) {
    const value = this.proven.find((item) => item.conversationId === conversationId);
    if (!value || projectRoot !== root) throw new Error('candidate lacks durable human-interaction provenance');
    return value;
  }
  async create(projectRoot: string) {
    if (projectRoot !== root) throw new Error('wrong root');
    const value = this.created.shift();
    if (!value) throw new Error('no controlled candidate');
    this.available.push(value);
    return value;
  }
  async bootstrap(projectRoot: string, operationId?: string) {
    const candidate = await this.create(projectRoot);
    if (operationId) this.receipts.set(operationId, candidate);
    return candidate;
  }
  recoverBootstrap(projectRoot: string, operationId: string) {
    const candidate = this.receipts.get(operationId);
    return candidate?.canonicalPath === projectRoot ? candidate : undefined;
  }
  async registerCreated(candidate: ProjectHumanThreadCandidate) {
    if (!this.proven.some((item) => item.conversationId === candidate.conversationId)) this.proven.push(candidate);
    return candidate;
  }
  repair(binding: { conversationId: string }) {
    return this.inspect(root, binding.conversationId);
  }
  prepareReplacement(binding: { conversationId: string }) {
    this.preparedReplacements.push(binding.conversationId);
  }
}

function setup() {
  return setupAt(':memory:');
}

function setupAt(path: string) {
  const store = new ProjectHumanThreadStore(path);
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
    authority.proven.push(first, second);
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
    expect(authority.preparedReplacements).toEqual([first.conversationId]);
    await expect(service.replace({
      ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered',
      idempotencyKey: 'human-thread:arcade:replace-1',
    })).resolves.toEqual({ outcome: 'current', binding: replacement.binding });
    expect(service.history('arcade')).toMatchObject([{ generation: 1, status: 'retired' }, { generation: 2, status: 'active' }]);
  });

  it('never bootstraps a successor until the durable predecessor handoff succeeds', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first, second);
    await service.createMissing(request);
    const create = vi.spyOn(authority, 'create');
    vi.spyOn(authority, 'prepareReplacement').mockImplementationOnce(() => {
      throw new Error('predecessor writer is still active');
    });
    await expect(service.replace({
      ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered',
      idempotencyKey: 'human-thread:arcade:replace-handoff',
    })).rejects.toThrow(/still active/);
    expect(create).not.toHaveBeenCalled();
    expect(store.current('arcade')).toMatchObject({ generation: 1, status: 'replacement-pending' });
  });

  it('persists create intent and never spawns a second conversation after an ambiguous failure', async () => {
    const { authority, service, store } = setup();
    const create = vi.spyOn(authority, 'create').mockRejectedValue(new Error('ambiguous create'));
    await expect(service.createMissing(request)).rejects.toThrow(/ambiguous/);
    await expect(service.createMissing(request)).resolves.toEqual({ outcome: 'reconciliation-required', candidates: [] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.creationIntent('arcade')).toMatchObject({ state: 'prepared', eventId: request.idempotencyKey });
  });

  it('retries initial creation only after an exact typed no-side-effect result', async () => {
    const { authority, service } = setup();
    authority.created.push(first);
    const noEffect = Object.assign(new Error('bootstrap rejected before create'), { createEffect: 'none' as const });
    const bootstrap = vi.spyOn(authority, 'bootstrap')
      .mockRejectedValueOnce(noEffect)
      .mockImplementation(async (projectRoot) => authority.create(projectRoot));
    await expect(service.createMissing(request)).rejects.toThrow(/before create/);
    await expect(service.createMissing(request)).resolves.toMatchObject({
      outcome: 'created', binding: { conversationId: first.conversationId },
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it('recovers an exact bootstrap receipt after a crash before the creation candidate write', async () => {
    const { authority, service, store } = setup();
    store.beginCreationIntent('arcade', request.idempotencyKey, {
      projectRoot: root, provenanceDigest: request.provenanceDigest,
    }, { canonicalPath: root, dev: first.dev, ino: first.ino });
    store.markCreationStarted('arcade', request.idempotencyKey);
    authority.available.push(first);
    authority.receipts.set(request.idempotencyKey, first);
    const bootstrap = vi.spyOn(authority, 'bootstrap');
    await expect(service.createMissing(request)).resolves.toMatchObject({
      outcome: 'created', binding: { conversationId: first.conversationId },
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('persists the exact bootstrapped identity before registration and resumes that registration', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first);
    const bootstrap = vi.spyOn(authority, 'bootstrap');
    vi.spyOn(authority, 'registerCreated').mockRejectedValueOnce(new Error('registrar interrupted'));
    await expect(service.createMissing(request)).rejects.toThrow(/registrar interrupted/);
    expect(store.creationIntent('arcade')).toMatchObject({
      state: 'prepared', createPhase: 'created', createdCandidate: { conversationId: first.conversationId },
    });
    await expect(service.createMissing(request)).resolves.toMatchObject({
      outcome: 'created', binding: { conversationId: first.conversationId },
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('persists the exact replacement identity before registration and never bootstraps it twice', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    authority.created.push(second);
    const bootstrap = vi.spyOn(authority, 'bootstrap');
    vi.spyOn(authority, 'registerCreated').mockRejectedValueOnce(new Error('replacement registrar interrupted'));
    const replacement = {
      ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered',
      idempotencyKey: 'replace:arcade:registrar-resume',
    };
    await expect(service.replace(replacement)).rejects.toThrow(/registrar interrupted/);
    expect(store.replacementIntent('arcade')).toMatchObject({
      state: 'prepared', createPhase: 'created', createdCandidate: { conversationId: second.conversationId },
    });
    await expect(service.replace(replacement)).resolves.toMatchObject({
      outcome: 'replaced', binding: { conversationId: second.conversationId, creationMode: 'created' },
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('recovers an exact replacement bootstrap receipt after a crash before candidate persistence', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    const replacement = {
      ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered',
      idempotencyKey: 'replace:arcade:bootstrap-receipt',
    };
    const beginEventId = `${replacement.idempotencyKey}:begin`;
    store.beginReplacement(
      'arcade', 1, replacement.reason, '2026-08-22T12:00:01.000Z', beginEventId,
      {
        idempotencyKey: replacement.idempotencyKey,
        expectedGeneration: 1,
        projectRoot: root,
        provenanceDigest: replacement.provenanceDigest,
        reason: replacement.reason,
      },
      { canonicalPath: root, dev: second.dev, ino: second.ino },
    );
    store.markReplacementCreateStarted('arcade', beginEventId);
    authority.available.push(second);
    authority.receipts.set(beginEventId, second);
    const bootstrap = vi.spyOn(authority, 'bootstrap');
    await expect(service.replace(replacement)).resolves.toMatchObject({
      outcome: 'replaced', binding: { conversationId: second.conversationId, creationMode: 'created' },
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('offers explicit adoption when an ambiguous create left one verifiable candidate', async () => {
    const { authority, service } = setup();
    vi.spyOn(authority, 'create').mockImplementation(async () => {
      authority.available.push(first);
      throw new Error('response lost');
    });
    await expect(service.createMissing(request)).rejects.toThrow(/response lost/);
    await expect(service.createMissing(request)).resolves.toEqual({ outcome: 'reconciliation-required', candidates: [] });
  });

  it('never retries an ambiguous replacement create after a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roadex-replacement-restart-')), 'state.sqlite');
    const { authority, service, store } = setupAt(path);
    authority.created.push(first);
    await service.createMissing(request);
    const create = vi.spyOn(authority, 'create').mockRejectedValue(new Error('ambiguous replacement'));
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:1' };
    await expect(service.replace(replacement)).rejects.toThrow(/ambiguous replacement/);
    expect(store.current('arcade')).toMatchObject({ status: 'replacement-pending' });
    store.close();
    const reopenedStore = new ProjectHumanThreadStore(path);
    const reopenedService = new ProjectHumanThreadService(reopenedStore, authority, {
      now: () => '2026-08-22T12:00:00.000Z',
    });
    await expect(reopenedService.replace(replacement)).resolves.toEqual({ outcome: 'reconciliation-required', candidates: [] });
    expect(create).toHaveBeenCalledTimes(1);
    reopenedStore.close();
  });

  it('retries a replacement create only when the authority proves no side effect', async () => {
    const { authority, service } = setup();
    authority.created.push(first, second);
    await service.createMissing(request);
    const noEffect = Object.assign(new Error('validation rejected'), { createEffect: 'none' as const });
    const create = vi.spyOn(authority, 'create').mockRejectedValueOnce(noEffect).mockImplementation(async () => {
      const value = authority.created.shift();
      if (!value) throw new Error('no controlled candidate');
      authority.available.push(value);
      authority.proven.push(value);
      return value;
    });
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:no-effect' };
    await expect(service.replace(replacement)).rejects.toThrow(/validation rejected/);
    await expect(service.replace(replacement)).resolves.toMatchObject({ outcome: 'replaced', binding: { generation: 2 } });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not silently adopt an unproven candidate after an ambiguous create', async () => {
    const { authority, service } = setup();
    authority.created.push(first, second);
    await service.createMissing(request);
    const create = vi.spyOn(authority, 'create').mockImplementation(async () => {
      const value = authority.created.shift();
      if (!value) throw new Error('no controlled candidate');
      authority.available.push(value);
      throw new Error('post-create response lost');
    });
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:invisible' };
    await expect(service.replace(replacement)).rejects.toThrow(/post-create response lost/);
    await expect(service.replace(replacement)).resolves.toEqual({ outcome: 'reconciliation-required', candidates: [] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a divergent retry while a replacement intent is pending', async () => {
    const { authority, service } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:2' };
    vi.spyOn(authority, 'create').mockRejectedValue(new Error('create interrupted'));
    await expect(service.replace(replacement)).rejects.toThrow(/interrupted/);
    await expect(service.replace({ ...replacement, idempotencyKey: 'replace:arcade:other' })).rejects.toThrow(/intent conflict/);
  });

  it('resumes the exact created candidate when activation crashes and never creates a duplicate', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    authority.created.push(second);
    const activate = vi.spyOn(store, 'activateReplacement').mockImplementationOnce(() => {
      throw new Error('activation interrupted');
    });
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:3' };
    await expect(service.replace(replacement)).rejects.toThrow(/activation interrupted/);
    await expect(service.replace(replacement)).resolves.toMatchObject({ outcome: 'replaced', binding: { conversationId: second.conversationId, creationMode: 'created' } });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('reconciles an activation that committed before intent completion', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first, second);
    await service.createMissing(request);
    const complete = vi.spyOn(store, 'completeReplacementIntent').mockImplementationOnce(() => {
      throw new Error('completion interrupted');
    });
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:complete' };
    await expect(service.replace(replacement)).rejects.toThrow(/completion interrupted/);
    await expect(service.replace(replacement)).resolves.toMatchObject({ outcome: 'current', binding: { generation: 2 } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.replacementIntent('arcade')).toMatchObject({ state: 'completed', conversationId: second.conversationId });
  });

  it('reports a replacement-pending binding honestly instead of converting it to unavailable', async () => {
    const { authority, service } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    authority.created.push(second);
    vi.spyOn(authority, 'create').mockRejectedValue(new Error('create interrupted'));
    const replacement = { ...request, expectedGeneration: 1, reason: 'Thread cannot be recovered', idempotencyKey: 'replace:arcade:4' };
    await expect(service.replace(replacement)).rejects.toThrow(/create interrupted/);
    expect(service.recover('arcade', 1, 'recover:arcade:pending')).toMatchObject({
      outcome: 'replacement-pending', binding: { status: 'replacement-pending' },
    });
  });

  it('fails closed on a legacy pending binding without an intent and exposes only manual candidates', async () => {
    const { authority, service, store } = setup();
    authority.created.push(first);
    await service.createMissing(request);
    store.beginReplacement('arcade', 1, 'legacy pending', '2026-08-22T12:01:00.000Z', 'legacy:replacement:1');
    authority.available.push(second);
    authority.proven.push(second);
    const replacement = { ...request, expectedGeneration: 1, reason: 'New reason', idempotencyKey: 'replace:legacy:new' };
    await expect(service.replace(replacement)).rejects.toThrow(/intent conflict/);
    expect(service.replacementCandidates('arcade', root)).toEqual([second]);
    await expect(service.reconcile({ projectId: 'arcade', projectRoot: root, expectedGeneration: 1, conversationId: second.conversationId }))
      .resolves.toMatchObject({ outcome: 'replaced', binding: { generation: 2, creationMode: 'adopted' } });
  });
});
