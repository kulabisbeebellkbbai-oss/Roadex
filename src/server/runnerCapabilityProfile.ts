export const CONTROLLED_RUNNER_PROFILE = 'roadex-controlled-project-manager';
export const CONTROLLED_RUNNER_CONFIG_OVERRIDES = [
  'approval_policy="never"',
  'sandbox_mode="workspace-write"',
  'sandbox_workspace_write.network_access=false',
  'mcp_servers.the-a-team.url="http://127.0.0.1:8795/mcp"',
  'mcp_servers.the-a-team.required=true',
  'mcp_servers.the-a-team.enabled_tools=["clarify_project_summary","create_team","list_teams","update_assignment","update_team"]',
  'mcp_servers.the-a-team.default_tools_approval_mode="approve"',
  'mcp_servers.skiller.url="http://127.0.0.1:8794/mcp"',
  'mcp_servers.skiller.required=true',
  'mcp_servers.skiller.enabled_tools=["capture_work_product","recommend_skills","record_skill_run"]',
  'mcp_servers.skiller.default_tools_approval_mode="approve"',
] as const;

export type RunnerCapabilitySelection =
  | { mode: 'restricted' }
  | {
      mode: 'controlled-project-manager';
      profile: typeof CONTROLLED_RUNNER_PROFILE;
    };

export type RunnerCapabilityContext = {
  userId: string;
  workspaceId: string;
};

export type RunnerCapabilityPolicyOptions = {
  env?: NodeJS.ProcessEnv;
};

export function resolveRunnerCapabilityProfile(
  context: RunnerCapabilityContext,
  options: RunnerCapabilityPolicyOptions = {},
): RunnerCapabilitySelection {
  const env = options.env ?? process.env;
  if (env.ROADEX_CONTROLLED_RUNNER_ENABLED !== 'true') {
    return { mode: 'restricted' };
  }

  const allowedUsers = parseExactAllowlist(env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS);
  const allowedWorkspaces = parseExactAllowlist(env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS);
  if (!allowedUsers.has(context.userId) || !allowedWorkspaces.has(context.workspaceId)) {
    return { mode: 'restricted' };
  }

  return {
    mode: 'controlled-project-manager',
    profile: CONTROLLED_RUNNER_PROFILE,
  };
}

function parseExactAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(entry)),
  );
}
