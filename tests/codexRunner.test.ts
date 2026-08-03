import { describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexExecArgs,
  createCodexRunner,
  parseCodexJsonl,
  parseCodexJsonlEvents,
} from '../src/server/codexRunner';
import { APPROVAL_WORKFLOW_TOKEN_DIRECTORY } from '../src/server/runnerCapabilityProfile';

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
      `mcp_servers.overseer.args=["/home/god/Documents/Codex Workspace/Roadex/dist-server/src/server/overseerMcp.js"]`,
      '--config',
      'mcp_servers.overseer.required=true',
      '--config',
      'mcp_servers.overseer.enabled_tools=["service_status","remote_testing_status","record_crew_message"]',
      '--config',
      'mcp_servers.overseer.default_tools_approval_mode="approve"',
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
    const tokenFile = '/run/user/1000/roadex-controlled-operation-tokens/11111111-1111-4111-8111-111111111111';
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

  it('adds one approval workflow tool only for controlled profiles with a bounded token file', () => {
    const tokenFile = `${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/11111111-1111-4111-9111-111111111111`;
    const args = buildCodexExecArgs(
      '/tmp/workspace',
      'get human approval',
      'thread-456',
      {
        mode: 'controlled-project-manager',
        profile: 'roadex-controlled-project-manager',
      },
      undefined,
      tokenFile,
    );
    expect(args).toContain('mcp_servers.roadex-workflow.command="node"');
    expect(args).toContain(
      `mcp_servers.roadex-workflow.env={ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE="${tokenFile}",ROADEX_APPROVAL_WORKFLOW_SOCKET="/run/user/1000/roadex-approval-workflow.sock"}`,
    );
    expect(args).toContain('mcp_servers.roadex-workflow.enabled_tools=["await_human_approval"]');
    expect(args.join(' ')).not.toContain('a'.repeat(40));
    try {
      const approvalOnly = args.filter((entry) => entry.includes('await_human_approval'));
      expect(approvalOnly).toHaveLength(1);
    } finally {
      // In this test environment, the workflow token path is intentionally not created.
    }
  });

  it('does not wrap prompts when only a workflow override is requested', () => {
    const tokenFile = `${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/22222222-2222-4222-8222-222222222222`;
    const args = buildCodexExecArgs(
      '/tmp/workspace',
      'get human approval',
      'thread-888',
      {
        mode: 'controlled-project-manager',
        profile: 'roadex-controlled-project-manager',
      },
      undefined,
      tokenFile,
    );
    expect(args.at(-1)).toBe('get human approval');
    expect(args.join(' ')).not.toContain('Execute this approved directive');
    expect(args.join(' ')).not.toContain('Approved directive:');
  });

  it('rejects malformed approval workflow token paths in config generation', () => {
    const args = buildCodexExecArgs(
      '/tmp/workspace',
      'get human approval',
      'thread-789',
      {
        mode: 'controlled-project-manager',
        profile: 'roadex-controlled-project-manager',
      },
      undefined,
      'bad token',
    );
    expect(args.join('\n')).not.toContain('roadex-workflow');
    expect(args.at(-1)).toBe('get human approval');
  });

  it('does not inject approval workflow MCP for restricted runs', () => {
    const tokenFile = `${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/33333333-3333-4333-a333-333333333333`;
    try {
      const args = buildCodexExecArgs(
        '/tmp/workspace',
        'hello',
        'thread-111',
        {
          mode: 'restricted',
        },
        undefined,
        tokenFile,
      );
      expect(args.join(' ')).not.toContain('roadex-workflow');
    } finally {
      // In this test environment, the workflow token path is intentionally not created.
    }
  });

  it('leaves prompts unchanged in restricted mode with a workflow token file', () => {
    const tokenFile = `${APPROVAL_WORKFLOW_TOKEN_DIRECTORY}/44444444-4444-4444-b444-444444444444`;
    const args = buildCodexExecArgs(
      '/tmp/workspace',
      'check logs',
      'thread-222',
      {
        mode: 'restricted',
      },
      undefined,
      tokenFile,
    );
    expect(args.at(-1)).toBe('check logs');
    expect(args.join(' ')).not.toContain('Execute this approved directive');
    expect(args.join(' ')).not.toContain('Approved directive:');
  });

  it('remove approval workflow token file after controlled runs', async () => {
    const workflowTokenDirectory = mkdtempSync(join('/tmp', 'roadex-approval-workflow-'));

    vi.resetModules();
    vi.doMock('../src/server/runnerCapabilityProfile', async () => {
      const actual = await vi.importActual<typeof import('../src/server/runnerCapabilityProfile')>(
        '../src/server/runnerCapabilityProfile',
      );
      return {
        ...actual,
        APPROVAL_WORKFLOW_TOKEN_DIRECTORY: workflowTokenDirectory,
      };
    });

    const { createCodexRunner: createMockCodexRunner } = await import('../src/server/codexRunner');
    const directory = mkdtempSync(join('/tmp', 'roadex-runner-'));
    const executable = join(directory, 'codex');
    writeFileSync(executable, [
      '#!/bin/sh',
      'exit 0',
    ].join('\n'));
    chmodSync(executable, 0o700);

    const runner = createMockCodexRunner({ executable });
    const session = runner.createSession({
      userId: 'owner',
      workspace: {
        id: 'roadex',
        name: 'Roadex',
        root: directory,
      },
    });

    const originalEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    const originalUsers = process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS;
    const originalWorkspaces = process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS = 'owner';
    process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS = 'roadex';

    const before = readdirSync(workflowTokenDirectory).sort();
    const result = await runner.runPrompt({
      session,
      prompt: 'continue',
      approvalWorkflowToken: 'c'.repeat(40),
    });
    const after = readdirSync(workflowTokenDirectory).sort();

    if (originalEnabled === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    else process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = originalEnabled;
    if (originalUsers === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS;
    else process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS = originalUsers;
    if (originalWorkspaces === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS;
    else process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS = originalWorkspaces;
    vi.doUnmock('../src/server/runnerCapabilityProfile');

    expect(result).toMatchObject({ ok: true });
    expect(after).toEqual(before);
  });

  it('removes controlled token files when approval token setup fails', async () => {
    const controlledOperationTokenDirectory = mkdtempSync(join(tmpdir(), 'roadex-controlled-operation-tokens-'));
    const approvalWorkflowTokenDirectory = mkdtempSync(join(tmpdir(), 'roadex-approval-workflow-tokens-'));
    const fdPathMap = new Map<number, string>();

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>) => {
          const descriptor = actual.openSync(...args);
          const path = String(args[0]);
          fdPathMap.set(descriptor, path);
          return descriptor;
        },
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          const descriptor = args[0];
          if (typeof descriptor === 'number'
            && fdPathMap.get(descriptor)?.startsWith(approvalWorkflowTokenDirectory)
          ) {
            throw new Error('approval token write failure');
          }
          return actual.writeFileSync(...args);
        },
      };
    });

    vi.doMock('../src/server/runnerCapabilityProfile', async () => {
      const actual = await vi.importActual<typeof import('../src/server/runnerCapabilityProfile')>(
        '../src/server/runnerCapabilityProfile',
      );
      return {
        ...actual,
        CONTROLLED_OPERATION_TOKEN_DIRECTORY: controlledOperationTokenDirectory,
        APPROVAL_WORKFLOW_TOKEN_DIRECTORY: approvalWorkflowTokenDirectory,
      };
    });

    const { createCodexRunner: mockCreateCodexRunner } = await import('../src/server/codexRunner');
    const originalEnabled = process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    const originalUsers = process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS;
    const originalWorkspaces = process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS;
    process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = 'true';
    process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS = 'owner';
    process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS = 'roadex';

    const runner = mockCreateCodexRunner({ executable: '/usr/bin/true' });
    const session = runner.createSession({
      userId: 'owner',
      workspace: { id: 'roadex', name: 'Roadex', root: controlledOperationTokenDirectory },
    });

    await expect(runner.runPrompt({
      session,
      prompt: 'continue',
      controlledOperationToken: 'a'.repeat(40),
      approvalWorkflowToken: 'b'.repeat(40),
    })).rejects.toThrow();

    if (originalEnabled === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_ENABLED;
    else process.env.ROADEX_CONTROLLED_RUNNER_ENABLED = originalEnabled;
    if (originalUsers === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS;
    else process.env.ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS = originalUsers;
    if (originalWorkspaces === undefined) delete process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS;
    else process.env.ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS = originalWorkspaces;

    expect(readdirSync(controlledOperationTokenDirectory)).toHaveLength(0);
    expect(readdirSync(approvalWorkflowTokenDirectory)).toHaveLength(0);
  });

  it('does not leave partial approval workflow token files when write fails', async () => {
    const approvalWorkflowTokenDirectory = mkdtempSync(join(tmpdir(), 'roadex-approval-workflow-tokens-'));
    const fdPathMap = new Map<number, string>();

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>) => {
          const descriptor = actual.openSync(...args);
          fdPathMap.set(descriptor, String(args[0]));
          return descriptor;
        },
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          const descriptor = args[0];
          if (typeof descriptor === 'number' && fdPathMap.get(descriptor)?.startsWith(approvalWorkflowTokenDirectory)) {
            throw new Error('approval token write failure');
          }
          return actual.writeFileSync(...args);
        },
      };
    });

    vi.doMock('../src/server/runnerCapabilityProfile', async () => {
      const actual = await vi.importActual<typeof import('../src/server/runnerCapabilityProfile')>(
        '../src/server/runnerCapabilityProfile',
      );
      return {
        ...actual,
        APPROVAL_WORKFLOW_TOKEN_DIRECTORY: approvalWorkflowTokenDirectory,
      };
    });

    const { createApprovalWorkflowTokenFile } = await import('../src/server/codexRunner');
    expect(() => createApprovalWorkflowTokenFile('c'.repeat(40))).toThrow();
    expect(readdirSync(approvalWorkflowTokenDirectory)).toHaveLength(0);
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
