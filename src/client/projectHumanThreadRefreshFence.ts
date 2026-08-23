export type ProjectHumanThreadProjectIdentity = { id: string; root: string; authEpoch: string };
export type ProjectHumanThreadRefreshToken = ProjectHumanThreadProjectIdentity & { sequence: number };

export class ProjectHumanThreadRefreshFence {
  #sequence = 0;

  beginIfCurrent(
    project: ProjectHumanThreadProjectIdentity,
    currentProject?: ProjectHumanThreadProjectIdentity,
  ): ProjectHumanThreadRefreshToken | undefined {
    if (!sameProject(project, currentProject)) return undefined;
    return { ...project, sequence: ++this.#sequence };
  }

  isCurrent(token: ProjectHumanThreadRefreshToken, project?: ProjectHumanThreadProjectIdentity): boolean {
    return Boolean(project)
      && token.sequence === this.#sequence
      && token.id === project?.id
      && token.root === project?.root
      && token.authEpoch === project?.authEpoch;
  }
}

export function projectHumanThreadIdempotencyScope(
  authEpoch: string,
  action: string,
  body: Record<string, unknown>,
): string {
  return `${authEpoch.length}:${authEpoch}:${action}:${JSON.stringify(body)}`;
}

function sameProject(
  left: ProjectHumanThreadProjectIdentity,
  right?: ProjectHumanThreadProjectIdentity,
): boolean {
  return Boolean(right)
    && left.id === right?.id
    && left.root === right?.root
    && left.authEpoch === right?.authEpoch;
}
