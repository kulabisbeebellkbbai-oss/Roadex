export const CONTROLLED_RUNNER_PROFILE = 'roadex-controlled-project-manager';
export const CONTROLLED_OVERSEER_MCP = '/home/god/Documents/Codex Workspace/Roadex/dist-server/src/server/overseerMcp.js';
export const CONTROLLED_OPERATIONS_MCP = '/home/god/Documents/Codex Workspace/Roadex/dist-server/src/server/controlledOperationsMcp.js';
export const CONTROLLED_OPERATIONS_SOCKET = '/run/user/1000/roadex-controlled-operations.sock';
export const CONTROLLED_OPERATION_TOKEN_DIRECTORY = '/run/user/1000/roadex-controlled-operation-tokens';
export const APPROVAL_WORKFLOW_MCP = '/home/god/Documents/Codex Workspace/Roadex/dist-server/src/server/approvalWorkflowMcp.js';
export const APPROVAL_WORKFLOW_SOCKET = '/run/user/1000/roadex-approval-workflow.sock';
export const APPROVAL_WORKFLOW_TOKEN_DIRECTORY = '/run/user/1000/roadex-approval-workflow-tokens';
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
  'mcp_servers.overseer.command="node"',
  `mcp_servers.overseer.args=["${CONTROLLED_OVERSEER_MCP}"]`,
  'mcp_servers.overseer.required=true',
  'mcp_servers.overseer.enabled_tools=["service_status","remote_testing_status","record_crew_message","get_crew_request","list_crew_requests","resubmit_crew_request"]',
  'mcp_servers.overseer.default_tools_approval_mode="approve"',
  'mcp_servers.theunderdark.url="http://127.0.0.1:8799/mcp"',
  'mcp_servers.theunderdark.required=true',
  'mcp_servers.theunderdark.enabled_tools=["underdark_project_get","underdark_root_get","underdark_path_stat","underdark_directory_list","underdark_operation_get","underdark_health_get"]',
  'mcp_servers.theunderdark.default_tools_approval_mode="approve"',
  'mcp_servers.playwright.command="/usr/bin/npx"',
  'mcp_servers.playwright.args=["--yes","@playwright/mcp@latest"]',
  'mcp_servers.playwright.required=true',
  'mcp_servers.playwright.enabled_tools=["browser_navigate","browser_resize","browser_snapshot","browser_evaluate","browser_take_screenshot","browser_console_messages","browser_close"]',
  'mcp_servers.playwright.default_tools_approval_mode="approve"',
] as const;

export function controlledOperationConfigOverrides(tokenFile: string | undefined): string[] {
  if (
    !tokenFile
    || !new RegExp(`^${CONTROLLED_OPERATION_TOKEN_DIRECTORY}/[0-9a-f-]{36}$`).test(tokenFile)
  ) return [];
  return [
    'mcp_servers.roadex-operations.command="node"',
    `mcp_servers.roadex-operations.args=["${CONTROLLED_OPERATIONS_MCP}"]`,
    `mcp_servers.roadex-operations.env={ROADEX_CONTROLLED_OPERATION_TOKEN_FILE="${tokenFile}",ROADEX_CONTROLLED_OPERATION_SOCKET="${CONTROLLED_OPERATIONS_SOCKET}"}`,
    'mcp_servers.roadex-operations.required=true',
    'mcp_servers.roadex-operations.enabled_tools=["install_and_verify_workspace","publish_git_changes"]',
    'mcp_servers.roadex-operations.default_tools_approval_mode="approve"',
  ];
}

export function approvalWorkflowConfigOverrides(tokenFile: string | undefined): string[] {
  if (!tokenFile || !new RegExp(`^${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/[0-9a-f-]{36}$`).test(tokenFile)) {
    return [];
  }
  return [
    'mcp_servers.roadex-workflow.command="node"',
    `mcp_servers.roadex-workflow.args=["${APPROVAL_WORKFLOW_MCP}"]`,
    `mcp_servers.roadex-workflow.env={ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE="${tokenFile}",ROADEX_APPROVAL_WORKFLOW_SOCKET="${APPROVAL_WORKFLOW_SOCKET}"}`,
    'mcp_servers.roadex-workflow.required=true',
    'mcp_servers.roadex-workflow.enabled_tools=["await_human_approval"]',
    'mcp_servers.roadex-workflow.default_tools_approval_mode="approve"',
  ];
}

export type RunnerCapabilitySelection =
  | { mode: 'restricted' }
  | {
      mode: 'controlled-project-manager';
      profile: typeof CONTROLLED_RUNNER_PROFILE;
    };

export type RunnerCapabilityContext = {
  userId: string;
  workspaceId: string;
  workspaceRoot?: string;
  managedThreadId?: string;
  codexThreadId?: string;
};

export type ControlledRunnerGrant = {
  userId: string;
  workspaceId: string;
  workspaceRoot: string;
  managedThreadId: string;
  operationId: string;
  status: 'active';
};

export type RunnerCapabilityPolicyOptions = {
  env?: NodeJS.ProcessEnv;
  grant?: ControlledRunnerGrant;
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
  const staticallyAllowed = allowedUsers.has(context.userId) && allowedWorkspaces.has(context.workspaceId);
  const grant = options.grant;
  const dynamicallyAllowed = Boolean(
    grant
    && grant.status === 'active'
    && grant.userId === context.userId
    && grant.workspaceId === context.workspaceId
    && grant.workspaceRoot === context.workspaceRoot
    && grant.managedThreadId === context.managedThreadId
    && grant.managedThreadId === context.codexThreadId,
  );
  if (!staticallyAllowed && !dynamicallyAllowed) {
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
