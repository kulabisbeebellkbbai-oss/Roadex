import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexExecArgs, createCodexRunner, parseCodexJsonl, parseCodexJsonlEvents } from '../src/server/codexRunner';
import {
  createApprovalWorkflowTokenFile,
} from '../src/server/codexRunner';
import {
  APPROVAL_WORKFLOW_TOKEN_DIRECTORY,
  CONTROLLED_OPERATION_TOKEN_DIRECTORY,
} from '../src/server/runnerCapabilityProfile';

describe('createCodexRunner', () => {
  it('creates Codex sessions with device bridge disabled', () => {
    const runner = createCodexRunner({ executable: 'codex' });
    const session = runner.createSession({
      userId: 'user-1',
      workspace: {
        id: 'roadex',
        name: 'Roadex Portal',
        root: process.cwd(),
      },
    });

    expect(session).toMatchObject({
      userId: 'user-1',
      lifecycle: 'ready',
      runnerMode: 'codex',
      transport: 'sse',
      deviceBridge: 'disabled',
    });
    expect(session.id).toMatch(/^codex-roadex-/);
    expect(session.gates.find((gate) => gate.id === 'device-bridge')).toMatchObject({
      state: 'deferred',
    });
  });

  it('uses the installed Codex exec argument shape without unsupported approval flags', () => {
    expect(buildCodexExecArgs('/tmp/workspace', 'hello')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-C',
      '/tmp/workspace',
      'hello',
    ]);
  });

  it('uses Codex exec resume when a thread id is already known', () => {
    expect(buildCodexExecArgs('/tmp/workspace', 'hello again', 'thread-123')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-C',
      '/tmp/workspace',
      'resume',
      'thread-123',
      'hello again',
    ]);
  });

  it('loads only the source-controlled capability profile when selected', () => {
    expect(buildCodexExecArgs(
      '/tmp/workspace',
      'continue',
      'thread-123',
      {
        mode: 'controlled-project-manager',
        profile: 'roadex-controlled-project-manager',
      },
    )).toEqual([
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--config',
      'approval_policy="never"',
      '--config',
      'sandbox_mode="workspace-write"',
      '--config',
      'sandbox_workspace_write.network_access=false',
      '--config',
      'mcp_servers.the-a-team.url="http://127.0.0.1:8795/mcp"',
      '--config',
      'mcp_servers.the-a-team.required=true',
      '--config',
      'mcp_servers.the-a-team.enabled_tools=["clarify_project_summary","create_team","list_teams","update_assignment","update_team"]',
      '--config',
      'mcp_servers.the-a-team.default_tools_approval_mode="approve"',
      '--config',
      'mcp_servers.skiller.url="http://127.0.0.1:8794/mcp"',
      '--config',
      'mcp_servers.skiller.required=true',
      '--config',
      'mcp_servers.skiller.enabled_tools=["capture_work_product","recommend_skills","record_skill_run"]',
      '--config',
      'mcp_servers.skiller.default_tools_approval_mode="approve"',
      '--config',
      'mcp_servers.overseer.command="node"',
      '--config',
      'mcp_servers.overseer.args=["/home/god/Documents/Codex Workspace/Roadex/dist-server/src/server/overseerMcp.js"]',
      '--config',
      'mcp_servers.overseer.required=true',
      '--config',
      'mcp_servers.overseer.enabled_tools=["service_status","remote_testing_status","record_crew_message","get_crew_request","list_crew_requests","resubmit_crew_request"]',
      '--config',
      'mcp_servers.overseer.default_tools_approval_mode="approve"',
      '--config',
      'mcp_servers.theunderdark.url="http://127.0.0.1:8799/mcp"',
      '--config',
      'mcp_servers.theunderdark.required=true',
      '--config',
      'mcp_servers.theunderdark.enabled_tools=["underdark_project_get","underdark_root_get","underdark_path_stat","underdark_directory_list","underdark_operation_get","underdark_health_get"]',
      '--config',
      'mcp_servers.theunderdark.default_tools_approval_mode="approve"',
      '--config',
      'mcp_servers.playwright.command="/usr/bin/npx"',
      '--config',
      'mcp_servers.playwright.args=["--yes","@playwright/mcp@latest"]',
      '--config',
      'mcp_servers.playwright.required=true',
      '--config',
      'mcp_servers.playwright.enabled_tools=["browser_navigate","browser_resize","browser_snapshot","browser_evaluate","browser_take_screenshot","browser_console_messages","browser_close"]',
      '--config',
      'mcp_servers.playwright.default_tools_approval_mode="approve"',
      '--sandbox',
      'workspace-write',
      '-C',
      '/tmp/workspace',
      'resume',
      'thread-123',
      'continue',
    ]);
  });

  it('adds the bounded operations MCP only when a fixed one-time token file is supplied', () => {
    const tokenFile = '/run/user/1000/roadex-controlled-operation-tokens/12345678-1234-1234-1234-123456789abc';
    const args = buildCodexExecArgs(
      '/tmp/workspace',
      'commit and push',
      'thread-123',
      {
        mode: 'controlled-project-manager',
        profile: 'roadex-controlled-project-manager',
      },
      tokenFile,
    );

    expect(args).toContain('mcp_servers.roadex-operations.command="node"');
    expect(args).toContain(
      `mcp_servers.roadex-operations.env={ROADEX_CONTROLLED_OPERATION_TOKEN_FILE="${tokenFile}",ROADEX_CONTROLLED_OPERATION_SOCKET="/run/user/1000/roadex-controlled-operations.sock"}`,
    );
    expect(args.at(-1)).toContain(
      'Execute this approved directive only through the matching roadex-operations MCP tool.',
    );
    expect(args.at(-1)).toContain('Approved directive: commit and push');
    expect(args.at(-1)).toContain('Do not run npm installation, git commit, or git push commands directly.');
    expect(args.join('\n')).not.toContain('a'.repeat(40));
    const invalidTokenArgs = buildCodexExecArgs(
      '/tmp/workspace',
      'continue',
      'thread-123',
      {
        mode: 'controlled-project-manager',
        profile: 'roadex-controlled-project-manager',
      },
      'bad token',
    );
    expect(invalidTokenArgs.join('\n')).not.toContain('roadex-operations');
    expect(invalidTokenArgs.at(-1)).toBe('continue');
  });

  it('adds the bounded workflow MCP only for a controlled token with controlled-run identifier', () => {
    const rawToken = 'g'.repeat(43);
    const workflowToken = createApprovalWorkflowTokenFile(rawToken);
    try {
      const args = buildCodexExecArgs(
        '/tmp/workspace',
        'human approval needed',
        'thread-123',
        {
          mode: 'controlled-project-manager',
          profile: 'roadex-controlled-project-manager',
        },
        undefined,
        workflowToken,
        'run-123',
      );

      expect(args).toContain('mcp_servers.roadex-workflow.command="node"');
      expect(args).toContain(
        'mcp_servers.roadex-workflow.env={ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE="' + workflowToken + '",ROADEX_APPROVAL_WORKFLOW_SOCKET="/run/user/1000/roadex-approval-workflow.sock"}',
      );
      expect(args).toContain('mcp_servers.roadex-workflow.enabled_tools=["await_human_approval"]');
      expect(args).toContain('mcp_servers.roadex-workflow.default_tools_approval_mode="approve"');
      expect(args.at(-1)).toContain('human approval needed');
      expect(args.join('\n')).not.toContain(rawToken);
    } finally {
      unlinkSync(workflowToken);
    }
  });

  it('requires a workflow run identifier for workflow MCP overrides', () => {
    const workflowToken = createApprovalWorkflowTokenFile('k'.repeat(43));
    try {
      const args = buildCodexExecArgs(
        '/tmp/workspace',
        'no run id provided',
        'thread-123',
        {
          mode: 'controlled-project-manager',
          profile: 'roadex-controlled-project-manager',
        },
        undefined,
        workflowToken,
      );
      expect(args.join('\n')).not.toContain('roadex-workflow');
    } finally {
      unlinkSync(workflowToken);
    }
  });

  it('never injects workflow MCP for restricted runs', () => {
    const workflowToken = createApprovalWorkflowTokenFile('o'.repeat(43));
    try {
      const args = buildCodexExecArgs(
        '/tmp/workspace',
        'restricted run',
        'thread-123',
        { mode: 'restricted' },
        undefined,
        workflowToken,
        'run-123',
      );
      expect(args.join('\n')).not.toContain('roadex-workflow');
      expect(args.join('\n')).not.toContain('await_human_approval');
    } finally {
      unlinkSync(workflowToken);
    }
  });

  it('requires the exact canonical 256-bit workflow token shape', () => {
    expect(() => createApprovalWorkflowTokenFile('A'.repeat(42))).toThrow('approval_workflow_token_invalid');
    expect(() => createApprovalWorkflowTokenFile('A'.repeat(44))).toThrow('approval_workflow_token_invalid');
    expect(() => createApprovalWorkflowTokenFile(`${'A'.repeat(42)}.`)).toThrow('approval_workflow_token_invalid');
    expect(() => createApprovalWorkflowTokenFile(`${'A'.repeat(42)}B`)).toThrow('approval_workflow_token_invalid');
  });

  it.each(['write', 'sync'] as const)('removes a partial workflow token file when %s fails', (failure) => {
    const before = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
    expect(() => createApprovalWorkflowTokenFile('w'.repeat(43), {
      ...(failure === 'write'
        ? { writeFile: () => { throw new Error('write failed'); } }
        : { sync: () => { throw new Error('sync failed'); } }),
    })).toThrow(`${failure} failed`);
    expect(readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY)).toEqual(before);
  });

  it('removes the first token file when second token-file creation fails', async () => {
    const controlledBefore = readTokenFiles(CONTROLLED_OPERATION_TOKEN_DIRECTORY);
    const workflowBefore = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
    const root = mkdtempSync(join(tmpdir(), 'roadex-workflow-second-token-'));
    const runner = createCodexRunner({ executable: '/definitely/not/codex' });
    const session = runner.createSession({
      userId: 'owner',
      workspace: { id: 'roadex', name: 'Roadex', root },
    });
    session.managedThreadId = 'thread-roadex';
    session.codexThreadId = 'thread-roadex';
    const previousEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    try {
      await expect(runner.runPrompt({
        session,
        prompt: 'human pause',
        capabilityGrant: {
          userId: 'owner',
          workspaceId: 'roadex',
          workspaceRoot: root,
          managedThreadId: 'thread-roadex',
          operationId: 'operation-roadex',
          status: 'active',
        },
        controlledOperationToken: 'A'.repeat(43),
        approvalWorkflowToken: 'A'.repeat(42),
        runId: 'run-roadex',
      })).rejects.toThrow('approval_workflow_token_invalid');
      expect(readTokenFiles(CONTROLLED_OPERATION_TOKEN_DIRECTORY)).toEqual(controlledBefore);
      expect(readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY)).toEqual(workflowBefore);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
      } else {
        process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = previousEnabled;
      }
    }
  });

  it('removes both token files when child spawn fails', async () => {
    const controlledBefore = readTokenFiles(CONTROLLED_OPERATION_TOKEN_DIRECTORY);
    const workflowBefore = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
    const root = mkdtempSync(join(tmpdir(), 'roadex-workflow-spawn-failure-'));
    const runner = createCodexRunner({ executable: '/definitely/not/a/roadex-codex-binary' });
    const session = runner.createSession({
      userId: 'owner',
      workspace: { id: 'roadex', name: 'Roadex', root },
    });
    session.managedThreadId = 'thread-roadex';
    session.codexThreadId = 'thread-roadex';
    const previousEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    try {
      await expect(runner.runPrompt({
        session,
        prompt: 'human pause',
        capabilityGrant: {
          userId: 'owner',
          workspaceId: 'roadex',
          workspaceRoot: root,
          managedThreadId: 'thread-roadex',
          operationId: 'operation-roadex',
          status: 'active',
        },
        controlledOperationToken: 'A'.repeat(43),
        approvalWorkflowToken: '0'.repeat(43),
        runId: 'run-roadex',
      })).rejects.toBeTruthy();
      expect(readTokenFiles(CONTROLLED_OPERATION_TOKEN_DIRECTORY)).toEqual(controlledBefore);
      expect(readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY)).toEqual(workflowBefore);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
      } else {
        process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = previousEnabled;
      }
    }
  });

  it('rejects with a fixed redacted failure when pre-spawn workflow cleanup fails', async () => {
    const workflowBefore = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
    const root = mkdtempSync(join(tmpdir(), 'roadex-workflow-cleanup-pre-spawn-'));
    const rawToken = 'A'.repeat(43);
    const runner = createCodexRunner({
      executable: '/definitely/not/a/roadex-codex-binary',
      spawnProcess: () => {
        throw new Error('spawn detail must not escape');
      },
      approvalWorkflowTokenFileOperations: {
        unlink: () => {
          throw Object.assign(new Error(`unlink denied ${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}`), {
            code: 'EACCES',
          });
        },
      },
    });
    const session = runner.createSession({
      userId: 'owner',
      workspace: { id: 'roadex', name: 'Roadex', root },
    });
    session.managedThreadId = 'thread-roadex';
    session.codexThreadId = 'thread-roadex';
    const previousEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    let createdFiles: string[] = [];
    try {
      const failure = await runner.runPrompt({
        session,
        prompt: 'human pause',
        capabilityGrant: {
          userId: 'owner',
          workspaceId: 'roadex',
          workspaceRoot: root,
          managedThreadId: 'thread-roadex',
          operationId: 'operation-roadex',
          status: 'active',
        },
        approvalWorkflowToken: rawToken,
        runId: 'run-roadex',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      createdFiles = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY)
        .filter((file) => !workflowBefore.includes(file));
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('approval_workflow_token_cleanup_failed');
      expect((failure as Error).message).not.toContain(rawToken);
      expect((failure as Error).message).not.toContain(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
      expect(createdFiles).toHaveLength(1);
    } finally {
      for (const file of createdFiles) {
        unlinkSync(join(APPROVAL_WORKFLOW_TOKEN_DIRECTORY, file));
      }
      if (previousEnabled === undefined) {
        delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
      } else {
        process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = previousEnabled;
      }
    }
  });

  it('does not report success when post-run workflow cleanup fails', async () => {
    const workflowBefore = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
    const root = mkdtempSync(join(tmpdir(), 'roadex-workflow-cleanup-post-run-'));
    const executable = join(root, 'codex-cleanup-failure');
    const rawToken = 'Q'.repeat(43);
    writeFileSync(executable, [
      '#!/bin/sh',
      `printf '%s\\n' '{"type":"item.completed","item":{"text":"child completed"}}'`,
    ].join('\n'));
    chmodSync(executable, 0o700);
    const runner = createCodexRunner({
      executable,
      approvalWorkflowTokenFileOperations: {
        unlink: () => {
          throw Object.assign(new Error(`unlink denied ${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}`), {
            code: 'EACCES',
          });
        },
      },
    });
    const session = runner.createSession({
      userId: 'owner',
      workspace: { id: 'roadex', name: 'Roadex', root },
    });
    session.managedThreadId = 'thread-roadex';
    session.codexThreadId = 'thread-roadex';
    const previousEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    let createdFiles: string[] = [];
    try {
      const failure = await runner.runPrompt({
        session,
        prompt: 'human pause',
        capabilityGrant: {
          userId: 'owner',
          workspaceId: 'roadex',
          workspaceRoot: root,
          managedThreadId: 'thread-roadex',
          operationId: 'operation-roadex',
          status: 'active',
        },
        approvalWorkflowToken: rawToken,
        runId: 'run-roadex',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      createdFiles = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY)
        .filter((file) => !workflowBefore.includes(file));
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('approval_workflow_token_cleanup_failed');
      expect((failure as Error).message).not.toContain(rawToken);
      expect((failure as Error).message).not.toContain(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
      expect(createdFiles).toHaveLength(1);
    } finally {
      for (const file of createdFiles) {
        unlinkSync(join(APPROVAL_WORKFLOW_TOKEN_DIRECTORY, file));
      }
      if (previousEnabled === undefined) {
        delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
      } else {
        process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = previousEnabled;
      }
    }
  });

  it('removes the approval workflow token file after one controlled execution', async () => {
    const tokenFiles = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
    const root = mkdtempSync(join(tmpdir(), 'roadex-workflow-token-run-'));
    const executable = join(root, 'codex-workflow-token');
    writeFileSync(executable, [
      '#!/bin/sh',
      'printf "%s\\n" "$ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE"',
    ].join('\n'));
    chmodSync(executable, 0o700);
    const runner = createCodexRunner({ executable });
    const session = runner.createSession({
      userId: 'owner',
      workspace: { id: 'roadex', name: 'Roadex', root },
    });
    session.managedThreadId = 'thread-roadex';
    session.codexThreadId = 'thread-roadex';
    const previousEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    try {
      const result = await runner.runPrompt({
        session,
        prompt: 'human pause',
        capabilityGrant: {
          userId: 'owner',
          workspaceId: 'roadex',
          workspaceRoot: root,
          managedThreadId: 'thread-roadex',
          operationId: 'operation-roadex',
          status: 'active',
        },
        approvalWorkflowToken: 's'.repeat(43),
        runId: 'run-roadex',
      });

      expect(result.ok).toBe(true);
      const afterRun = readTokenFiles(APPROVAL_WORKFLOW_TOKEN_DIRECTORY);
      expect(afterRun).toEqual(tokenFiles);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
      } else {
        process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = previousEnabled;
      }
    }
  });

  it('extracts final answer text from Codex JSONL item events', () => {
    const messages = parseCodexJsonl(
      '{"type":"thread.started","thread_id":"abc"}\n' +
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"roadex-parser-ok"}}\n',
    );

    expect(messages).toEqual(['roadex-parser-ok']);
  });

  it('extracts Codex thread ids without rendering them as transcript messages', () => {
    const parsed = parseCodexJsonlEvents(
      '{"type":"thread.started","thread_id":"thread-abc"}\n' +
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"linked"}}\n',
    );

    expect(parsed.codexThreadId).toBe('thread-abc');
    expect(parsed.events).toEqual([
      { codexThreadId: 'thread-abc' },
      { message: 'linked', codexThreadId: undefined },
    ]);
    expect(parseCodexJsonl('{"type":"thread.started","thread_id":"thread-abc"}\n')).toEqual([]);
  });

  it('allows a long-running child to complete without a wall-clock deadline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-runner-'));
    const executable = join(directory, 'slow-codex');
    writeFileSync(executable, [
      '#!/bin/sh',
      'sleep 0.05',
      `printf '%s\\n' '{"type":"item.completed","item":{"text":"long run completed"}}'`,
    ].join('\n'));
    chmodSync(executable, 0o700);
    const runner = createCodexRunner({ executable, activityHeartbeatMs: 5 });
    const session = runner.createSession({
      userId: 'user-1',
      workspace: { id: 'roadex', name: 'Roadex', root: directory },
    });
    let activityChecks = 0;
    const result = await runner.runPrompt({
      session,
      prompt: 'continue',
      onActivity: () => {
        activityChecks += 1;
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(activityChecks).toBeGreaterThan(0);
    expect(result.events.some((event) => event.message === 'long run completed')).toBe(true);
    expect(result.events.some((event) => event.message.includes('timed out'))).toBe(false);
  });
});

function readTokenFiles(tokenDirectory: string): string[] {
  try {
    return readdirSync(tokenDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}
