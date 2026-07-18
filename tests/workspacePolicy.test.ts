import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { getApprovedWorkspaces, resolveWorkspaceForUser } from '../src/server/workspacePolicy';

const originalWorkspaces = process.env.ROADEX_WORKSPACES_JSON;
const originalRegistry = process.env.ROADEX_CODEX_PROJECTS_REGISTRY;

beforeEach(() => {
  process.env.ROADEX_CODEX_PROJECTS_REGISTRY = '/nonexistent/test-codex-projects.csv';
});

afterEach(() => {
  if (originalWorkspaces === undefined) {
    delete process.env.ROADEX_WORKSPACES_JSON;
  } else {
    process.env.ROADEX_WORKSPACES_JSON = originalWorkspaces;
  }
  if (originalRegistry === undefined) delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
  else process.env.ROADEX_CODEX_PROJECTS_REGISTRY = originalRegistry;
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

  it('does not expose managed projects without an explicit account allowlist', () => {
    delete process.env.ROADEX_CODEX_PROJECTS_REGISTRY;
    delete process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS;

    expect(getApprovedWorkspaces(mockUser).every((workspace) => !workspace.id.startsWith('codex-project-'))).toBe(true);
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
