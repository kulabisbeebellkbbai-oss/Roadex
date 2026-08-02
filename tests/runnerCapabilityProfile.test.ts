import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_RUNNER_PROFILE,
  APPROVAL_WORKFLOW_MCP,
  APPROVAL_WORKFLOW_SOCKET,
  APPROVAL_WORKFLOW_TOKEN_DIRECTORY,
  approvalWorkflowConfigOverrides,
  resolveRunnerCapabilityProfile,
} from '../src/server/runnerCapabilityProfile';

function controlledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ROADEX_CONTROLLED_RUNNER_ENABLED: 'true',
    ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS: 'owner',
    ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS: 'roadex',
    ...overrides,
  };
}

describe('resolveRunnerCapabilityProfile', () => {
  it('defaults to the restricted runner when the gate is not literal true', () => {
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'roadex' },
      { env: controlledEnv({ ROADEX_CONTROLLED_RUNNER_ENABLED: 'TRUE' }) },
    )).toEqual({ mode: 'restricted' });
  });

  it('requires both exact user and workspace allowlist entries', () => {
    const options = {
      env: controlledEnv(),
    };
    expect(resolveRunnerCapabilityProfile(
      { userId: 'other', workspaceId: 'roadex' },
      options,
    )).toEqual({ mode: 'restricted' });
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'other' },
      options,
    )).toEqual({ mode: 'restricted' });
  });

  it('selects the fixed profile after ownership, mode, and digest validation', () => {
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'roadex' },
      {
        env: controlledEnv(),
      },
    )).toEqual({
      mode: 'controlled-project-manager',
      profile: CONTROLLED_RUNNER_PROFILE,
    });
  });

  it('allows each exact configured workspace without matching a neighboring workspace', () => {
    const options = {
      env: controlledEnv({
        ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS: 'codex-project-ai-project-manager-cacb4e3a,codex-project-donuthole-5ccf3f70',
      }),
    };
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'codex-project-donuthole-5ccf3f70' },
      options,
    )).toEqual({
      mode: 'controlled-project-manager',
      profile: CONTROLLED_RUNNER_PROFILE,
    });
    expect(resolveRunnerCapabilityProfile(
      { userId: 'owner', workspaceId: 'codex-project-donuthole-5ccf3f70-other' },
      options,
    )).toEqual({ mode: 'restricted' });
  });

  it('ignores malformed allowlist entries instead of broadening access', () => {
    expect(resolveRunnerCapabilityProfile(
      { userId: '../owner', workspaceId: 'roadex' },
      {
        env: controlledEnv({
          ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS: '../owner, owner',
        }),
      },
    )).toEqual({ mode: 'restricted' });
  });

  it('accepts an exact active server grant when the static workspace allowlist does not match', () => {
    expect(resolveRunnerCapabilityProfile(
      {
        userId: 'owner',
        workspaceId: 'workspace-created',
        workspaceRoot: '/srv/projects/Created',
        managedThreadId: 'thread-created',
        codexThreadId: 'thread-created',
      },
      {
        env: controlledEnv(),
        grant: {
          userId: 'owner',
          workspaceId: 'workspace-created',
          workspaceRoot: '/srv/projects/Created',
          managedThreadId: 'thread-created',
          operationId: 'operation-created',
          status: 'active',
        },
      },
    )).toEqual({
      mode: 'controlled-project-manager',
      profile: CONTROLLED_RUNNER_PROFILE,
    });
  });

  it.each([
    ['userId', 'other'],
    ['workspaceId', 'workspace-neighbor'],
    ['workspaceRoot', '/srv/projects/Neighbor'],
    ['managedThreadId', 'thread-neighbor'],
    ['codexThreadId', 'thread-neighbor'],
  ] as const)('rejects a durable grant when %s drifts', (field, value) => {
    const context = {
      userId: 'owner',
      workspaceId: 'workspace-created',
      workspaceRoot: '/srv/projects/Created',
      managedThreadId: 'thread-created',
      codexThreadId: 'thread-created',
      [field]: value,
    };
    expect(resolveRunnerCapabilityProfile(context, {
      env: controlledEnv(),
      grant: {
        userId: 'owner',
        workspaceId: 'workspace-created',
        workspaceRoot: '/srv/projects/Created',
        managedThreadId: 'thread-created',
        operationId: 'operation-created',
        status: 'active',
      },
    })).toEqual({ mode: 'restricted' });
  });

  it('injects only the workflow MCP override when token file is valid', () => {
    const tokenFile = `${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/12345678-1234-1234-1234-123456789abc`;
    expect(approvalWorkflowConfigOverrides(tokenFile)).toEqual([
      'mcp_servers.roadex-workflow.command="node"',
      `mcp_servers.roadex-workflow.args=["${APPROVAL_WORKFLOW_MCP}"]`,
      `mcp_servers.roadex-workflow.env={ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE="${tokenFile}",ROADEX_APPROVAL_WORKFLOW_SOCKET="${APPROVAL_WORKFLOW_SOCKET}"}`,
      'mcp_servers.roadex-workflow.required=true',
      'mcp_servers.roadex-workflow.enabled_tools=["await_human_approval"]',
      'mcp_servers.roadex-workflow.default_tools_approval_mode="approve"',
    ]);
  });

  it('skips malformed workflow token files', () => {
    expect(approvalWorkflowConfigOverrides('/tmp/invalid-token')).toEqual([]);
  });
});
