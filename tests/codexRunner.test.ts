import { describe, expect, it } from 'vitest';
import { buildCodexExecArgs, createCodexRunner, parseCodexJsonl } from '../src/server/codexRunner';

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

  it('extracts final answer text from Codex JSONL item events', () => {
    const messages = parseCodexJsonl(
      '{"type":"thread.started","thread_id":"abc"}\n' +
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"roadex-parser-ok"}}\n',
    );

    expect(messages).toEqual(['roadex-parser-ok']);
  });
});
