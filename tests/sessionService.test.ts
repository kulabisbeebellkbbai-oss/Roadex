import { describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { createStreamEvent } from '../src/server/mockRunner';
import { createMemoryPersistence } from '../src/server/statePersistence';
import {
  bootstrap,
  closeSession,
  createInitialState,
  createMockSession,
  createSessionFromApi,
  cancelSessionRun,
  streamEventsForSession,
  subscribeToSessionStream,
  submitPrompt,
} from '../src/server/sessionService';
import type { UserProfile, WorkspaceRef } from '../src/shared/sessionContracts';
import type { RunnerPromptRequest, SessionRunner } from '../src/server/codexRunner';

const workspace: WorkspaceRef = {
  id: 'roadex',
  name: 'Roadex Portal',
  root: process.cwd(),
};

function fakeRunner(result: 'ok' | 'failed' = 'ok', codexThreadId?: string): SessionRunner {
  let sessions = 0;
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      sessions += 1;
      const now = new Date().toISOString();
      return {
        id: `codex-${selectedWorkspace.id}-${sessions}`,
        userId,
        workspace: selectedWorkspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async runPrompt({ session, prompt, onEvent, signal }: RunnerPromptRequest) {
      const events = [createStreamEvent(session.id, 'assistant', `Codex read: ${prompt}`)];
      for (const event of events) {
        if (signal?.aborted) break;
        onEvent?.(event);
      }
      if (result === 'failed') {
        return { ok: false, events, reason: 'runner_failed', codexThreadId };
      }
      return { ok: true, events, exitCode: 0, codexThreadId };
    },
  };
}

function controllableRunner(): SessionRunner {
  let sessions = 0;
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      sessions += 1;
      const now = new Date().toISOString();
      return {
        id: `codex-${selectedWorkspace.id}-${sessions}`,
        userId,
        workspace: selectedWorkspace,
        lifecycle: 'ready',
        runnerMode: 'codex',
        transport: 'sse',
        deviceBridge: 'disabled',
        gates: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async runPrompt({ session, onEvent, signal }: RunnerPromptRequest) {
      onEvent?.(createStreamEvent(session.id, 'assistant', 'runner started'));
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const event = createStreamEvent(session.id, 'system', 'cancel observed');
      onEvent?.(event);
      return { ok: false, events: [event], reason: 'runner_cancelled' };
    },
  };
}

function threadRecordingRunner(observedThreads: Array<string | undefined>): SessionRunner {
  let sessions = 0;
  let prompts = 0;
  return {
    createSession({ userId, workspace: selectedWorkspace }) {
      sessions += 1;
      const now = new Date().toISOString();
      return {
        id: `codex-${selectedWorkspace.id}-${sessions}`,
        userId,
        workspace: selectedWorkspace,
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
      prompts += 1;
      observedThreads.push(session.codexThreadId);
      const events = [createStreamEvent(session.id, 'assistant', `Codex read: ${prompt}`)];
      for (const event of events) {
        onEvent?.(event);
      }
      return { ok: true, events, exitCode: 0, codexThreadId: `thread-${prompts}` };
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

    const promptResult = submitPrompt(state, mockUser, response.session.id, 'hello roadex');
    expect(promptResult).toMatchObject({ accepted: true });
    await flushRunner();

    const events = streamEventsForSession(state, mockUser, response.session.id);
    expect(events?.map((event) => event.kind)).toContain('assistant');
    expect(events?.some((event) => event.message.includes('hello roadex'))).toBe(true);

    const intruder = { ...mockUser, id: 'other-user' };
    expect(streamEventsForSession(state, intruder, response.session.id)).toBeUndefined();
  });

  it('publishes runner events to live subscribers for the owning session', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const received: string[] = [];
    const subscription = subscribeToSessionStream(state, mockUser, response.session.id, (event) => {
      received.push(event.message);
    });

    expect(subscription?.snapshot.length).toBeGreaterThan(0);
    expect(submitPrompt(state, mockUser, response.session.id, 'live please')).toMatchObject({ accepted: true });
    await flushRunner();

    subscription?.unsubscribe();
    expect(received.some((message) => message.includes('live please'))).toBe(true);
  });

  it('stops publishing live events after unsubscribe', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const received: string[] = [];
    const subscription = subscribeToSessionStream(state, mockUser, response.session.id, (event) => {
      received.push(event.message);
    });
    subscription?.unsubscribe();

    submitPrompt(state, mockUser, response.session.id, 'after unsubscribe');
    await flushRunner();

    expect(received.some((message) => message.includes('after unsubscribe'))).toBe(false);
  });

  it('limits live subscribers per session and audits rejected connections', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxStreamSubscribersPerSession = 1;
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const first = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    const rejected = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);

    expect(first).toBeDefined();
    expect(rejected).toBeUndefined();
    expect(state.streamSubscribers.get(response.session.id)?.size).toBe(1);
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: mockUser.id,
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('Live stream subscriber limit reached');

    first?.unsubscribe();
  });

  it('checks stream ownership before reporting subscriber capacity', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxStreamSubscribersPerSession = 1;
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const first = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    const intruder = { ...mockUser, id: 'other-user' };
    const rejected = subscribeToSessionStream(state, intruder, response.session.id, () => undefined);

    expect(rejected).toBeUndefined();
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: intruder.id,
      resource: response.session.id,
    });
    expect(state.audit.events.at(-1)?.summary).toBe('SSE stream denied.');
    first?.unsubscribe();
  });

  it('allows a replacement live subscriber after an existing stream unsubscribes', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    state.maxStreamSubscribersPerSession = 1;
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const first = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    first?.unsubscribe();
    const replacement = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);

    expect(replacement).toBeDefined();
    expect(state.streamSubscribers.get(response.session.id)?.size).toBe(1);
    replacement?.unsubscribe();
  });

  it('blocks additional prompts after a failed runner while keeping failure events readable', async () => {
    const state = createInitialState(fakeRunner('failed'), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const promptResult = submitPrompt(state, mockUser, response.session.id, 'break safely');
    expect(promptResult).toMatchObject({ accepted: true });
    await flushRunner();

    expect(streamEventsForSession(state, mockUser, response.session.id)?.map((event) => event.message)).toContain(
      'Codex read: break safely',
    );
    expect(response.session.lifecycle).toBe('blocked');
    expect(streamEventsForSession(state, mockUser, response.session.id)?.length).toBeGreaterThan(0);
    expect(submitPrompt(state, mockUser, response.session.id, 'second prompt')).toBeUndefined();
  });

  it('hides blocked sessions from bootstrap and creates a replacement active session after restart', async () => {
    const persistence = createMemoryPersistence();
    const runner = fakeRunner('failed');
    const state = createInitialState(runner, persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'fail and replace');
    await flushRunner();

    const reloaded = createInitialState(runner, persistence);
    const bootstrapped = await bootstrap(reloaded, mockUser);

    expect(bootstrapped.sessions).toHaveLength(1);
    expect(bootstrapped.sessions[0].id).not.toBe(response.session.id);
    expect(bootstrapped.sessions[0].lifecycle).toBe('ready');
  });

  it('loads persisted sessions, stream events, and audit events after service restart', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(fakeRunner(), persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'persist me');
    await flushRunner();
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

  it('returns only the authenticated user audit events from bootstrap', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const regularUser = { ...mockUser, id: 'regular-user', roles: ['user'] as UserProfile['roles'] };
    const otherUser = { ...mockUser, id: 'other-user', displayName: 'Other user', roles: ['user'] as UserProfile['roles'] };

    await createSessionFromApi(state, regularUser, { workspaceId: 'roadex' });
    await createSessionFromApi(state, otherUser, { workspaceId: 'roadex' });

    const bootstrapped = await bootstrap(state, regularUser);

    expect(bootstrapped.auditEvents.length).toBeGreaterThan(0);
    expect(bootstrapped.auditEvents.every((event) => event.actorId === regularUser.id)).toBe(true);
    const visibleSessionIds = new Set(bootstrapped.sessions.map((session) => session.id));
    expect(bootstrapped.streamPreview.every((event) => visibleSessionIds.has(event.sessionId))).toBe(true);
  });

  it('allows security reviewers to inspect the global audit tail', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const regularUser = { ...mockUser, id: 'regular-user', roles: ['user'] as UserProfile['roles'] };

    await createSessionFromApi(state, regularUser, { workspaceId: 'roadex' });
    const bootstrapped = await bootstrap(state, mockUser);

    expect(bootstrapped.auditEvents.some((event) => event.actorId === regularUser.id)).toBe(true);
  });

  it('persists Codex thread ids so later prompts can resume the same thread after restart', async () => {
    const persistence = createMemoryPersistence();
    const state = createInitialState(fakeRunner('ok', 'thread-roadex-1'), persistence);
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'remember this thread');
    await flushRunner();

    expect(response.session.codexThreadId).toBe('thread-roadex-1');

    const reloaded = createInitialState(fakeRunner(), persistence);
    const bootstrapped = await bootstrap(reloaded, mockUser);

    expect(bootstrapped.sessions[0]).toMatchObject({
      id: response.session.id,
      codexThreadId: 'thread-roadex-1',
    });
  });

  it('passes the stored Codex thread id into later prompts for continuity', async () => {
    const observedThreads: Array<string | undefined> = [];
    const state = createInitialState(threadRecordingRunner(observedThreads), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'first');
    await flushRunner();
    submitPrompt(state, mockUser, response.session.id, 'second');
    await flushRunner();

    expect(observedThreads).toEqual([undefined, 'thread-1']);
    expect(response.session.codexThreadId).toBe('thread-2');
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

  it('cancels an active runner and returns the session to ready', async () => {
    const state = createInitialState(controllableRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'long run');
    await flushRunner();

    expect(response.session.lifecycle).toBe('streaming');
    expect(cancelSessionRun(state, mockUser, response.session.id)).toMatchObject({ cancelled: true });
    await flushRunner();

    expect(response.session.lifecycle).toBe('ready');
    expect(streamEventsForSession(state, mockUser, response.session.id)?.some((event) => event.message.includes('cancel'))).toBe(
      true,
    );
  });

  it('returns a not-running cancel result for an owned inactive session', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const cancel = cancelSessionRun(state, mockUser, response.session.id);

    expect(cancel).toMatchObject({
      cancelled: false,
      status: 'not-running',
      auditEvent: {
        action: 'session.cancel',
        outcome: 'denied',
      },
    });
    expect(cancel?.auditEvent.summary).toContain('active_runner=false');
  });

  it('archives an owned session and removes it from active bootstrap results', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const subscription = subscribeToSessionStream(state, mockUser, response.session.id, () => undefined);
    expect(subscription).toBeDefined();
    const close = closeSession(state, mockUser, response.session.id);
    const bootstrapped = await bootstrap(state, mockUser);

    expect(close).toMatchObject({
      closed: true,
      auditEvent: {
        action: 'session.close',
        outcome: 'allowed',
      },
    });
    expect(response.session.lifecycle).toBe('closed');
    expect(state.streamSubscribers.has(response.session.id)).toBe(false);
    expect(bootstrapped.sessions.some((session) => session.id === response.session.id)).toBe(false);
    expect(bootstrapped.sessions[0]).toMatchObject({
      lifecycle: 'ready',
      workspace: {
        id: 'roadex',
      },
    });
  });

  it('denies wrong-owner session archive attempts', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const intruder = { ...mockUser, id: 'other-user' };
    expect(closeSession(state, intruder, response.session.id)).toBeUndefined();
    expect(response.session.lifecycle).toBe('ready');
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: 'other-user',
      resource: response.session.id,
      outcome: 'denied',
    });
  });

  it('denies wrong-owner cancellation and records actor/session detail', async () => {
    const state = createInitialState(controllableRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    submitPrompt(state, mockUser, response.session.id, 'long run');
    await flushRunner();

    const intruder = { ...mockUser, id: 'other-user' };
    expect(cancelSessionRun(state, intruder, response.session.id)).toBeUndefined();
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      actorId: 'other-user',
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('session_not_owned_or_missing');
  });

  it('adds an alert-style audit event for repeated inactive cancel attempts', async () => {
    const state = createInitialState(fakeRunner(), createMemoryPersistence());
    const response = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    cancelSessionRun(state, mockUser, response.session.id);
    cancelSessionRun(state, mockUser, response.session.id);
    cancelSessionRun(state, mockUser, response.session.id);

    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      resource: response.session.id,
      outcome: 'denied',
    });
    expect(state.audit.events.at(-1)?.summary).toContain('Cancel alert');
    expect(state.audit.events.at(-1)?.summary).toContain('attempts=3');
  });

  it('enforces the active runner concurrency limit', async () => {
    const original = process.env.ROADEX_WORKSPACES_JSON;
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
      { id: 'gateway', name: 'Gateway', root: '/home/god/Documents/Codex Workspace/Protected Service Gateway' },
    ]);
    try {
      const state = createInitialState(controllableRunner(), createMemoryPersistence());
      state.maxActiveRuns = 1;
      const first = await createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });
      const second = await createSessionFromApi(state, mockUser, { workspaceId: 'gateway' });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(submitPrompt(state, mockUser, first.session.id, 'first')).toMatchObject({ accepted: true });
      await flushRunner();
      expect(submitPrompt(state, mockUser, second.session.id, 'second')).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.ROADEX_WORKSPACES_JSON;
      } else {
        process.env.ROADEX_WORKSPACES_JSON = original;
      }
    }
  });
});

async function flushRunner(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
