import { describe, expect, it } from 'vitest';
import { createMockSession } from '../src/server/sessionService';
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

  it('blocks workspaces outside the approved server root', () => {
    const response = createMockSession({
      userId: 'user-1',
      workspace: {
        ...workspace,
        root: '/tmp/roadex',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      gate: 'workspace',
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
