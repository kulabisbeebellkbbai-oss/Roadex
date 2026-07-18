import { isAbsolute, resolve } from 'node:path';
import type { UserProfile, WorkspaceRef } from '../shared/sessionContracts.js';
import { managedCodexWorkspaces } from './codexProjectsRegistry.js';

const defaultWorkspace = (): WorkspaceRef => ({
  id: 'roadex',
  name: 'Roadex Portal',
  root: process.env.ROADEX_WORKSPACE_ROOT ?? process.cwd(),
});

export function getApprovedWorkspaces(user?: UserProfile): WorkspaceRef[] {
  const raw = process.env.ROADEX_WORKSPACES_JSON;
  if (!raw) return combineManagedWorkspaces([defaultWorkspace()], user);
  try {
    const parsed = JSON.parse(raw) as WorkspaceRef[];
    const workspaces = parsed.map(normalizeWorkspace).filter((workspace): workspace is WorkspaceRef => Boolean(workspace));
    return combineManagedWorkspaces(workspaces.length > 0 ? workspaces : [defaultWorkspace()], user);
  } catch {
    return combineManagedWorkspaces([defaultWorkspace()], user);
  }
}

function combineManagedWorkspaces(configured: WorkspaceRef[], user?: UserProfile): WorkspaceRef[] {
  if (!user || !canAccessManagedCodexProjects(user)) return configured;
  try {
    const roots = new Set(configured.map((workspace) => workspace.root));
    return [
      ...configured,
      ...managedCodexWorkspaces().filter((workspace) => !roots.has(workspace.root)),
    ];
  } catch {
    return configured;
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

  const workspace = getApprovedWorkspaces(user).find((candidate) => candidate.id === workspaceId);
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

export function canAccessManagedCodexProjects(user: UserProfile): boolean {
  if (!user.roles.includes('security-reviewer')) return false;
  const approvedUsers = new Set(
    (process.env.ROADEX_CODEX_PROJECTS_AUTHORIZED_USERS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return approvedUsers.has(user.id);
}
