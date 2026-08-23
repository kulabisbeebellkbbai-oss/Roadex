import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('project human thread transcript client', () => {
  it('uses owner-scoped transcript reads and ordinary response submission', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      const payload = path.endsWith('/respond')
        ? { ok: true, requestedProjectId: 'arcade', canonicalProjectId: 'arcade', response: { responseId: 'response-1', messageId: 'question-1', projectId: 'arcade', conversationId: '11111111-1111-1111-1111-111111111111', generation: 1, content: 'Continue', correlationId: 'corr-1', occurredAt: '2026-08-22T13:00:00.000Z' } }
        : { ok: true, requestedProjectId: 'arcade', canonicalProjectId: 'arcade', questions: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-roadex-csrf': 'csrf-transcript-test' },
      });
    }));
    const { getProjectHumanThreadTranscript, submitProjectHumanThreadResponse } = await import('../src/client/projectHumanThreadTranscriptApi');
    await getProjectHumanThreadTranscript('token', 'arcade', 'pending');
    await getProjectHumanThreadTranscript('token', 'arcade', 'history');
    await submitProjectHumanThreadResponse('token', 'arcade', 'question-1', 'Continue', 'response-key-1');
    expect(calls.map((call) => call.path)).toEqual([
      '/Roadex/api/projects/arcade/human-thread/messages',
      '/Roadex/api/projects/arcade/human-thread/messages/history',
      '/Roadex/api/projects/arcade/human-thread/messages/question-1/respond',
    ]);
    const headers = new Headers(calls[2].init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('x-roadex-csrf')).toBe('csrf-transcript-test');
    expect(headers.get('idempotency-key')).toBe('response-key-1');
    expect(calls.some((call) => /approve|execute|deploy/.test(call.path))).toBe(false);
  });
});
