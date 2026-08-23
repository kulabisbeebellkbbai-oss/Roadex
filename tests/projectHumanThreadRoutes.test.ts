import { describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../src/shared/sessionContracts';
import { ProjectHumanThreadController } from '../src/server/projectHumanThreadController';
import { isAvailableProjectHumanThreadRoute, validProjectHumanThreadCsrf } from '../src/server/projectHumanThreadPolicy';

const owner: UserProfile = {
  id: 'owner', displayName: 'Owner', authMode: 'protected-gateway', roles: ['user', 'security-reviewer'],
};
const binding = {
  schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
  bindingId: 'project-human-thread:arcade:1',
  projectId: 'arcade',
  root: { canonicalPath: '/srv/arcade', dev: 1, ino: 2 },
  purpose: 'human-interaction' as const,
  conversationId: '019fc36f-0570-7623-912f-6da8181eda2d',
  generation: 1,
  status: 'active' as const,
  predecessorGeneration: null,
  creationMode: 'created' as const,
  provenanceDigest: 'a'.repeat(64),
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  retiredAt: null,
  recordDigest: 'b'.repeat(64),
};

function fixture(activeRun = false, pendingInteraction = false, activeConversation = false) {
  const service = {
    current: vi.fn(() => binding),
    history: vi.fn(() => [binding]),
    candidates: vi.fn(() => []),
    createMissing: vi.fn(async () => ({ outcome: 'current', binding })),
    adopt: vi.fn(async () => ({ outcome: 'current', binding })),
    recover: vi.fn(() => ({ outcome: 'recovered', binding })),
    replace: vi.fn(async () => ({ outcome: 'replaced', binding: { ...binding, generation: 2 } })),
    replacementIntent: vi.fn(() => undefined),
    replacementCandidates: vi.fn(() => []),
    resume: vi.fn(async () => ({ outcome: 'replacement-pending', binding })),
    reconcile: vi.fn(async () => ({ outcome: 'replaced', binding: { ...binding, generation: 2 } })),
  };
  const controller = new ProjectHumanThreadController(service, {
    resolveOwnedProject: (user, projectId) => user.id === owner.id && projectId === 'arcade'
      ? { projectId, root: '/srv/arcade', activeRun }
      : undefined,
    hasPendingInteraction: () => pendingInteraction,
    hasActiveConversation: () => activeConversation,
  });
  return { controller, service };
}

describe('project human thread route policy', () => {
  it('is default-off and exposes only the exact route family when enabled', () => {
    expect(isAvailableProjectHumanThreadRoute('GET', '/api/projects/arcade/human-thread', {})).toBe(false);
    const env = { ROADEX_PROJECT_HUMAN_THREAD_ENABLED: 'true' } as NodeJS.ProcessEnv;
    expect(isAvailableProjectHumanThreadRoute('GET', '/api/projects/arcade/human-thread', env)).toBe(true);
    expect(isAvailableProjectHumanThreadRoute('POST', '/api/projects/arcade/human-thread/replace', env)).toBe(true);
    expect(isAvailableProjectHumanThreadRoute('POST', '/api/projects/arcade/human-thread/resume', env)).toBe(true);
    expect(isAvailableProjectHumanThreadRoute('POST', '/api/projects/arcade/human-thread/reconcile', env)).toBe(true);
    expect(isAvailableProjectHumanThreadRoute('POST', '/api/projects/arcade/human-thread/approve', env)).toBe(false);
    expect(isAvailableProjectHumanThreadRoute('GET', '/api/projects/arcade/human-thread?x=1', env)).toBe(false);
  });

  it('requires one bounded CSRF header for mutations', () => {
    expect(validProjectHumanThreadCsrf(undefined)).toBe(false);
    expect(validProjectHumanThreadCsrf(['one', 'two'])).toBe(false);
    expect(validProjectHumanThreadCsrf(' private ')).toBe(false);
    expect(validProjectHumanThreadCsrf('private-test-value')).toBe(true);
  });
});

describe('ProjectHumanThreadController', () => {
  it('returns current, redacted history, and candidate inspection only to the owner', () => {
    const { controller } = fixture();
    expect(controller.read(owner, 'arcade')).toMatchObject({ current: binding, candidates: [] });
    const redacted: Partial<typeof binding> = { ...binding };
    delete redacted.root;
    delete redacted.provenanceDigest;
    expect(controller.history(owner, 'arcade')).toEqual([redacted]);
    expect(() => controller.read({ ...owner, id: 'other' }, 'arcade')).toThrow(/not found/i);
  });

  it('strictly creates, adopts, and recovers without accepting approval-like fields', async () => {
    const { controller, service } = fixture();
    await controller.createMissing(owner, 'arcade', 'create-key-00000001', {});
    await controller.adopt(owner, 'arcade', 'adopt-key-000000001', {
      conversationId: binding.conversationId,
    });
    controller.recover(owner, 'arcade', 'recover-key-0000001', { expectedGeneration: 1 });
    await expect(controller.createMissing(owner, 'arcade', 'create-key-00000002', { approved: true })).rejects.toThrow(/invalid/i);
    expect(service.createMissing).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'arcade', projectRoot: '/srv/arcade', idempotencyKey: 'create-key-00000001',
    }));
  });

  it('requires exact generation and bounded reason and blocks replacement during an active run', async () => {
    const { controller, service } = fixture(true);
    await expect(controller.adopt(owner, 'arcade', 'adopt-key-active-001', {
      conversationId: binding.conversationId,
    })).rejects.toThrow(/active run/i);
    expect(service.adopt).not.toHaveBeenCalled();
    const activeCandidate = fixture(false, false, true);
    await expect(activeCandidate.controller.adopt(owner, 'arcade', 'adopt-key-active-002', {
      conversationId: binding.conversationId,
    })).rejects.toThrow(/active run/i);
    expect(activeCandidate.service.adopt).not.toHaveBeenCalled();
    await expect(controller.replace(owner, 'arcade', 'replace-key-0000001', {
      expectedGeneration: 1, reason: 'Replace unavailable thread',
    })).rejects.toThrow(/active run/i);
    const inactive = fixture(false).controller;
    await expect(inactive.replace(owner, 'arcade', 'replace-key-0000001', {
      expectedGeneration: 1, reason: 'Replace unavailable thread', approved: true,
    })).rejects.toThrow(/invalid/i);
  });

  it('blocks replacement while the project has pending human interaction', async () => {
    const pending = fixture(false, true).controller;
    await expect(pending.replace(owner, 'arcade', 'replace-key-pending', {
      expectedGeneration: 1, reason: 'Replace unavailable thread',
    })).rejects.toThrow(/human interaction is pending/i);
  });

  it('resumes and reconciles a pending replacement without accepting a new client idempotency key', async () => {
    const { controller, service } = fixture(false);
    await expect(controller.resume(owner, 'arcade', { expectedGeneration: 1 })).resolves.toMatchObject({ outcome: 'replacement-pending' });
    await expect(controller.reconcile(owner, 'arcade', {
      expectedGeneration: 1, conversationId: binding.conversationId,
    })).resolves.toMatchObject({ outcome: 'replaced' });
    expect(service.resume).toHaveBeenCalledWith({ projectId: 'arcade', projectRoot: '/srv/arcade', expectedGeneration: 1 });
  });

  it('applies the pending-interaction fence to resume and reconcile as well as replace', async () => {
    const { controller, service } = fixture(false, true);
    await expect(controller.resume(owner, 'arcade', { expectedGeneration: 1 })).rejects.toThrow(/human interaction is pending/i);
    await expect(controller.reconcile(owner, 'arcade', {
      expectedGeneration: 1, conversationId: binding.conversationId,
    })).rejects.toThrow(/human interaction is pending/i);
    expect(service.resume).not.toHaveBeenCalled();
    expect(service.reconcile).not.toHaveBeenCalled();
  });
});
