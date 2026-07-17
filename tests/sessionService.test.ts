import { describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import {
  createInitialState,
  createMockSession,
  createSessionFromApi,
  streamEventsForSession,
  submitPrompt,
} from '../src/server/sessionService';
import type { WorkspaceRef } from '../src/shared/sessionContracts';

const workspace: WorkspaceRef = {
  id: 'roadex',
  name: 'Roadex Portal',
  root: '/srv/roadex/projects/roadex',
};

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
  it('creates a session from a server-owned workspace id and records audit', () => {
    const state = createInitialState();
    const response = createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response).toMatchObject({
      ok: true,
      session: {
        userId: mockUser.id,
        runnerMode: 'mock',
      },
    });
    expect(state.audit.events.map((event) => event.action)).toContain('session.create');
  });

  it('rejects unknown workspace ids instead of accepting browser-supplied roots', () => {
    const state = createInitialState();
    const response = createSessionFromApi(state, mockUser, { workspaceId: '../roadex' });

    expect(response).toMatchObject({
      ok: false,
      gate: 'workspace',
    });
    expect(state.audit.events.at(-1)).toMatchObject({
      action: 'security.denied',
      outcome: 'denied',
    });
  });

  it('rejects requested device bridge access and records denial', () => {
    const state = createInitialState();
    const response = createSessionFromApi(state, mockUser, {
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

  it('submits prompts and streams only for the owning user', () => {
    const state = createInitialState();
    const response = createSessionFromApi(state, mockUser, { workspaceId: 'roadex' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const promptResult = submitPrompt(state, mockUser, response.session.id, 'hello roadex');
    expect(promptResult?.events.map((event) => event.kind)).toContain('assistant');

    const events = streamEventsForSession(state, mockUser, response.session.id);
    expect(events?.some((event) => event.message.includes('hello roadex'))).toBe(true);

    const intruder = { ...mockUser, id: 'other-user' };
    expect(streamEventsForSession(state, intruder, response.session.id)).toBeUndefined();
  });
});
