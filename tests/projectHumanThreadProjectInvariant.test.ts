import { describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { createStreamEvent } from '../src/server/mockRunner';
import {
  bootstrap,
  closeSession,
  createInitialState,
  createSessionFromApi,
  listArchivedSessions,
  reopenSession,
  streamEventsForSession,
  submitPrompt,
} from '../src/server/sessionService';
import { createMemoryPersistence } from '../src/server/statePersistence';
import type { RunnerPromptRequest, SessionRunner } from '../src/server/codexRunner';
import type { WorkspaceRef } from '../src/shared/sessionContracts';

const project: WorkspaceRef = {
  id: 'roadex',
  name: 'Arcade',
  root: process.cwd(),
};

function runner(): SessionRunner {
  let next = 0;
  return {
    createSession({ userId, workspace }) {
      next += 1;
      const now = new Date().toISOString();
      return {
        id: `session-${next}`,
        userId,
        workspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async runPrompt({ session, prompt, onEvent }: RunnerPromptRequest) {
      const event = createStreamEvent(session.id, 'assistant', `echo:${prompt}`);
      onEvent?.(event);
      return { ok: true, events: [event], exitCode: 0, codexThreadId: session.codexThreadId };
    },
  };
}

describe('single Roadex project human-thread invariant', () => {
  it('fences ordinary creation for a governed project root for every user', async () => {
    const state = createInitialState(runner(), createMemoryPersistence());
    const roots: string[] = [];
    state.isProjectHumanThreadProject = (root) => {
      roots.push(root);
      return true;
    };

    expect(await createSessionFromApi(state, mockUser, { workspaceId: project.id })).toMatchObject({
      ok: false,
      gate: 'project-human-thread',
    });
    expect(await createSessionFromApi(state, { ...mockUser, id: 'another-user' }, { workspaceId: project.id })).toMatchObject({
      ok: false,
      gate: 'project-human-thread',
    });
    expect(roots).toEqual([process.cwd(), process.cwd()]);
  });

  it('fences and hides an existing ordinary session without deleting its history', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(runner(), persistence);
    state.isProjectHumanThreadProject = () => false;
    const created = await createSessionFromApi(state, mockUser, { workspaceId: project.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await closeSession(state, mockUser, created.session.id);
    state.isProjectHumanThreadProject = () => true;
    expect(listArchivedSessions(state, mockUser)).toEqual([]);
    expect(await reopenSession(state, mockUser, created.session.id)).toBeUndefined();
    expect(streamEventsForSession(state, mockUser, created.session.id)).toBeUndefined();
    expect(submitPrompt(state, mockUser, created.session.id, 'must not write')).toBeUndefined();

    expect(state.sessions.sessions).toContain(created.session);
    expect(persistence.load().sessions).toContainEqual(expect.objectContaining({ id: created.session.id }));
  });

  it('applies the same root fence to the managed-thread list', async () => {
    const state = createInitialState(runner(), createMemoryPersistence());
    state.isProjectHumanThreadProject = () => true;
    expect((await bootstrap(state, mockUser)).managedThreads).toEqual([]);
  });

  it('canonicalizes an alias before asking the authority about the project', async () => {
    const state = createInitialState(runner(), createMemoryPersistence());
    const observed: string[] = [];
    state.isProjectHumanThreadProject = (root) => {
      observed.push(root);
      return true;
    };
    expect(await createSessionFromApi(state, mockUser, { workspaceId: project.id })).toMatchObject({
      ok: false,
      gate: 'project-human-thread',
    });
    expect(observed).toEqual([process.cwd()]);
  });
});
