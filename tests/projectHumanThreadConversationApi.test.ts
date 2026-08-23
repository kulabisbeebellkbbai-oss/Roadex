import { afterEach, describe, expect, it, vi } from 'vitest';

const projectId = 'arcade';
const conversationId = '11111111-1111-1111-1111-111111111111';
const timestamp = '2026-08-23T14:00:00.000Z';

function turn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: 'project-human-thread-turn:abc', projectId, conversationId, generation: 1,
    content: 'ping', correlationId: 'corr-1', idempotencyKey: 'turn-key-1', state: 'queued',
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

describe('project human thread conversation client', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('accepts an exact conversation and binds every turn to its conversation generation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, conversationId, generation: 1, turns: [turn()] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { getProjectHumanThreadConversation } = await import('../src/client/projectHumanThreadConversationApi');
    await expect(getProjectHumanThreadConversation(undefined, projectId)).resolves.toMatchObject({ conversationId, generation: 1 });
  });

  it('rejects cross-conversation, cross-generation, extra-field, and impossible-state responses', async () => {
    const payloads = [
      { ok: true, conversationId, generation: 1, turns: [turn({ conversationId: '22222222-2222-2222-2222-222222222222' })] },
      { ok: true, conversationId, generation: 1, turns: [turn({ generation: 2 })] },
      { ok: true, conversationId, generation: 1, turns: [turn()], unexpected: true },
      { ok: true, conversationId, generation: 1, turns: [turn({ state: 'completed' })] },
    ];
    const fetch = vi.fn(async () => new Response(JSON.stringify(payloads.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const { getProjectHumanThreadConversation } = await import('../src/client/projectHumanThreadConversationApi');
    for (let index = 0; index < 4; index += 1) await expect(getProjectHumanThreadConversation(undefined, projectId)).rejects.toThrow(/response is invalid/i);
  });

  it('binds a submitted response to the exact content, correlation, and idempotency key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, turn: turn({ content: 'substituted' }) }), { status: 202, headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'csrf-token-00000001' } })));
    const { submitProjectHumanThreadTurn } = await import('../src/client/projectHumanThreadConversationApi');
    await expect(submitProjectHumanThreadTurn(undefined, projectId, 'ping', 'corr-1', 'turn-key-1')).rejects.toThrow(/response is invalid/i);
  });
});
