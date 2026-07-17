import { describe, expect, it } from 'vitest';
import { mockUser } from '../src/server/authService';
import { resolveWorkspaceForUser } from '../src/server/workspacePolicy';

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
});
