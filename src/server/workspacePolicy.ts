import type { UserProfile, WorkspaceRef } from '../shared/sessionContracts.js';

export const approvedWorkspaces: WorkspaceRef[] = [
  {
    id: 'roadex',
    name: 'Roadex Portal',
    root: '/srv/roadex/projects/roadex',
  },
];

export type WorkspaceDecision =
  | {
      ok: true;
      workspace: WorkspaceRef;
    }
  | {
      ok: false;
      reason: string;
    };

export function resolveWorkspaceForUser(user: UserProfile, workspaceId: string): WorkspaceDecision {
  if (!user.roles.includes('user')) {
    return {
      ok: false,
      reason: 'User is not authorized for Roadex workspaces.',
    };
  }

  const workspace = approvedWorkspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return {
      ok: false,
      reason: 'Workspace must be selected from the server-approved list.',
    };
  }

  return {
    ok: true,
    workspace,
  };
}
