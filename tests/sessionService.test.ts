import { describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { createStreamEvent } from '../src/server/mockRunner';
import { createMemoryPersistence } from '../src/server/statePersistence';
import {
  bootstrap,
  createInitialState,
  createMockSession,
  createSessionFromApi,
  streamEventsForSession,
  submitPrompt,
} from '../src/server/sessionService';
import type { RoadexSession, WorkspaceRef } from '../src/shared/sessionContracts';
import type { SessionRunner } from '../src/server/codexRunner';

const workspace: WorkspaceRef = {
  id: 'roadex',
  name: 'Roadex Portal',
  root: process.cwd(),
};

function fakeRunner(result: 'ok' | 'failed' = 'ok'): SessionRunner {
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      return {
        id: `codex-${selectedWorkspace.id}`,
        userId,
        workspace: selectedWorkspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
      };
    },
    async runPrompt({ session, prompt }: { session: RoadexSession; prompt: string }) {
      const events = [createStreamEvent(session.id, 'assistant', `Codex read: ${prompt}`)];
      if (result === 'failed') {
        return { ok: false, events, reason: 'runner_failed' };
      }
      return { ok: true, events, exitCode: 0 };
    },
  };
}

describe('createMockSession', () => {
  it('requires authentication before creating a session', () => {
    const response = createMockSession({ workspace });

    expect(response).toMatchObject({
      ok: false,
      gate: 'auth',
    });
  });

  it('keeps device bridge access disabled in the first milestone', () => {
    const response = createMockSession({
      userId: 'user-1',
      workspace,
      requestedDeviceBridge: true,
    });

    expect(response).toMatchObject({
      ok: false,
      gate: 'device-bridge',
    });
  });

  it('creates a ready mock session for an authenticated user and approved workspace', () => {
    const response = createMockSession({
      userId: 'user-1',
      workspace,
    });

    expect(response).toMatchObject({
      ok: true,
      session: {
        lifecycle: 'ready',
        runnerMode: 'mock',
        transport: 'sse',
        deviceBridge: 'disabled',
      },
    });
  });
});

describe('Roadex session service', () => {
  it('creates a session from a server-owned workspace id and records audit', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response).toMatchObject({
      ok: true,
      session: {
        userId: mockUser.id,
        runnerMode: 'codex',
      },
    });
    expect(state.audit.events.map((event) => event.action)).toContain('session.create');
  });

  it('rejects unknown workspace ids instead of accepting browser-supplied roots', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: '../roadex' });

    expect(response).toMatchObject({
      ok: false,
      gate: 'workspace',
    });
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      outcome: 'denied',
    });
  });

  it('rejects requested device bridge access and records denial', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, {
      workspaceId: 'roadex',
      requestedDeviceBridge: true,
    });

    expect(response).toMatchObject({
      ok: false,
      gate: 'device-bridge',
    });
    expect(state.audit.events.at(-1)).toMatchObject({
      resource: 'device-bridge',
      outcome: 'denied',
    });
  });

  it('submits prompts to the real runner abstraction and streams only for the owning user', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const promptResult = await submitPrompt(state, mockUser, response.session.id, 'hello roadex');
    expect(promptResult?.events.map((event) => event.kind)).toContain('assistant');

    const events = streamEventsForSession(state, mockUser, response.session.id);
    expect(events?.some((event) => event.message.includes('hello roadex'))).toBe(true);

    const intruder = { ...mockUser, id: 'other-user' };
    expect(streamEventsForSession(state, intruder, response.session.id)).toBeUndefined();
  });

  it('blocks additional prompts after a failed runner while keeping failure events readable', async () => {
    const state = createInitialState(fakeRunner('failed'), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const promptResult = await submitPrompt(state, mockUser, response.session.id, 'break safely');

    expect(promptResult?.events.map((event) => event.message)).toContain('Codex read: break safely');
    expect(response.session.lifecycle).toBe('blocked');
    expect(streamEventsForSession(state, mockUser, response.session.id)?.length).toBeGreaterThan(0);
    await expect(submitPrompt(state, mockUser, response.session.id, 'second prompt')).resolves.toBeUndefined();
  });

  it('loads persisted sessions, stream events, and audit events after service restart', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(fakeRunner(), persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    await submitPrompt(state, mockUser, response.session.id, 'persist me');
    const reloaded = createInitialState(fakeRunner(), persistence);
    const bootstrapped = await bootstrap(reloaded, mockUser);

    expect(bootstrapped.sessions).toHaveLength(1);
    expect(bootstrapped.sessions[0]).toMatchObject({
      id: response.session.id,
      workspace: {
        id: 'roadex',
      },
    });
    expect(bootstrapped.streamPreview.some((event) => event.message.includes('persist me'))).toBe(true);
    expect(bootstrapped.auditEvents.some((event) => event.action === 'session.prompt')).toBe(true);
  });

  it('supports multiple server-approved workspaces by id only', async () => {
    const original = process.env.ROADEX_WORKSPACES_JSON;
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
      { id: 'gateway', name: 'Protected Gateway', root: '/home/god/Documents/Codex Workspace/Protected Service Gateway' },
    ]);
    try {
      const state = createInitialState(fakeRunner(), createMemoryPersistence());
      const defaultBootstrap = await bootstrap(state, mockUser);
      const response = await createSessionFromApi(state, mockUser, { workspaceId: 'gateway' });
      const nextBootstrap = await bootstrap(state, mockUser);

      expect(defaultBootstrap.workspaces.map((workspace) => workspace.id)).toEqual(['roadex', 'gateway']);
      expect(response).toMatchObject({
        ok: true,
        session: {
          workspace: {
            id: 'gateway',
            root: '/home/god/Documents/Codex Workspace/Protected Service Gateway',
          },
        },
      });
      expect(nextBootstrap.sessions.map((session) => session.workspace.id)).toEqual(['roadex', 'gateway']);
    } finally {
      if (original === undefined) {
        delete process.env.ROADEX_WORKSPACES_JSON;
      } else {
        process.env.ROADEX_WORKSPACES_JSON = original;
      }
    }
  });
});
