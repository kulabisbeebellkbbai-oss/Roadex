import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexExecArgs, createCodexRunner, parseCodexJsonl, parseCodexJsonlEvents } from '../src/server/codexRunner';

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
