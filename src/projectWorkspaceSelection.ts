import type { RoadexSession, WorkspaceRef } from './shared/sessionContracts';

export function resolveProjectWorkspace(
  workspaces: WorkspaceRef[],
  selectedProjectId: string,
  session?: Pick<RoadexSession, 'workspace'>,
): WorkspaceRef | undefined {
  const requested = selectedProjectId || session?.workspace.id;
  return workspaces.find((workspace) => workspace.id === requested) ?? workspaces[0];
}
