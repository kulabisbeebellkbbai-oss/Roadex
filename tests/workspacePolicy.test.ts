import { afterEach, describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { getApprovedWorkspaces, resolveWorkspaceForUser } from '../src/server/workspacePolicy';

const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;

afterEach(() => {
  if (originalWorkspaces === undefined) {
    delete process.env.ROADEX_WORKSPACES_JSON;
  } else {
    process.env.ROADEX_WORKSPACES_JSON = originalWorkspaces;
  }
});

describe('workspace policy', () => {
  it('allows known workspace ids for an authorized user', () => {
    expect(resolveWorkspaceForUser(mockUser, 'roadex')).toMatchObject({
      ok: true,
      workspace: {
        root: process.cwd(),
      },
    });
  });

  it('denies traversal and unknown workspace ids', () => {
    expect(resolveWorkspaceForUser(mockUser, '../roadex')).toMatchObject({ ok: false });
    expect(resolveWorkspaceForUser(mockUser, '/srv/roadex/projects/roadex')).toMatchObject({
      ok: false,
    });
  });

  it('loads multiple server-approved workspaces from JSON config', () => {
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
      { id: 'gateway', name: 'Gateway', root: '/home/god/Documents/Codex Workspace/Protected Service Gateway' },
    ]);

    expect(getApprovedWorkspaces().map((workspace) => workspace.id)).toEqual(['roadex', 'gateway']);
    expect(resolveWorkspaceForUser(mockUser, 'gateway')).toMatchObject({
      ok: true,
      workspace: {
        name: 'Gateway',
      },
    });
  });

  it('rejects invalid configured workspace ids and relative roots', () => {
    process.env.ROADEX_WORKSPACES_JSON = JSON.stringify([
      { id: '../bad', name: 'Bad', root: process.cwd() },
      { id: 'relative', name: 'Relative', root: 'relative/path' },
      { id: 'roadex', name: 'Roadex Portal', root: process.cwd() },
    ]);

    expect(getApprovedWorkspaces().map((workspace) => workspace.id)).toEqual(['roadex']);
  });
});
