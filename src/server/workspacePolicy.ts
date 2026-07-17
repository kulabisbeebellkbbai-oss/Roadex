import { isAbsolute, resolve } from 'node:path';
import type { UserProfile, WorkspaceRef } from '../shared/sessionContracts.js';

const defaultWorkspace = (): WorkspaceRef => ({
  id: 'roadex',
  name: 'Roadex Portal',
  root: process.env.ROADEX_WORKSPACE_ROOT ?? process.cwd(),
});

export function getApprovedWorkspaces(): WorkspaceRef[] {
  const raw = process.env.ROADEX_WORKSPACES_JSON;
  if (!raw) return [defaultWorkspace()];
  try {
    const parsed = JSON.parse(raw) as WorkspaceRef[];
    const workspaces = parsed.map(normalizeWorkspace).filter((workspace): workspace is WorkspaceRef => Boolean(workspace));
    return workspaces.length > 0 ? workspaces : [defaultWorkspace()];
  } catch {
    return [defaultWorkspace()];
  }
}

function normalizeWorkspace(candidate: WorkspaceRef): WorkspaceRef | undefined {
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.root !== 'string') return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(candidate.id)) return undefined;
  if (!isAbsolute(candidate.root)) return undefined;
  const root = resolve(candidate.root);
  return {
    id: candidate.id,
    name: candidate.name || candidate.id,
    root,
  };
}

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

  const workspace = getApprovedWorkspaces().find((candidate) => candidate.id === workspaceId);
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
