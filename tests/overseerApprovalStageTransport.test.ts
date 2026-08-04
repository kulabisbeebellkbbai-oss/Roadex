import { describe, expect, it } from 'vitest';
import {
  createOverseerApprovalStageTransport,
  type ApprovalStageLocator,
} from '../src/server/overseerApprovalStageTransport';
import { validProvisioningIntent } from './approvalFixtures';

const capability = {
  sessionId: 'session-1',
  userId: 'owner',
  projectId: 'project.donuthole',
  workspaceId: 'workspace.donuthole',
  resourceRef: 'storage.donuthole',
  managedThreadId: 'thread-1',
};

const locator: ApprovalStageLocator = {
  provider: 'overseer',
  approvalRef: 'approval.roadex.test',
  projectId: 'project.donuthole',
  workspaceId: 'workspace.donuthole',
  resourceRef: 'storage.donuthole',
  authorityClass: 'project-workflow',
  scopeDigest: `sha256:${'a'.repeat(64)}`,
};

function responseFor(value: unknown, status = 200, includeLength = true): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: includeLength ? { 'content-length': String(Buffer.byteLength(body)) } : {},
  });
}

describe('Overseer approval staging transport', () => {
  it('POSTs exactly the intent to the fixed authenticated stage endpoint and validates the locator', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const stage = createOverseerApprovalStageTransport({
      readToken: () => 'root-owned-token',
      fetchImpl: async (input, init) => {
        calls.push({ input: String(input), init: init ?? {} });
        return responseFor(locator);
      },
    });

    await expect(stage(capability, validProvisioningIntent())).resolves.toEqual(locator);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://127.0.0.1:8766/roadex/approval-stage');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({
      Authorization: 'Bearer root-owned-token',
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(JSON.stringify({ intent: validProvisioningIntent() }))),
    });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ intent: validProvisioningIntent() }));
  });

  it.each([
    ['missing field', (() => { const intent = validProvisioningIntent(); delete (intent as Record<string, unknown>).reason; return intent; })()],
    ['extra field', { ...validProvisioningIntent(), authority: 'caller-supplied' }],
  ])('rejects %s intent fields before making a request', async (_label, intent) => {
    let requests = 0;
    const stage = createOverseerApprovalStageTransport({
      readToken: () => 'root-owned-token',
      fetchImpl: async () => {
        requests += 1;
        return responseFor(locator);
      },
    });

    await expect(stage(capability, intent as never)).rejects.toThrow('Overseer approval staging is unavailable.');
    expect(requests).toBe(0);
  });

  it('rejects a mismatched response locator and malformed HTTP framing', async () => {
    const stage = createOverseerApprovalStageTransport({
      readToken: () => 'root-owned-token',
      fetchImpl: async () => responseFor({ ...locator, projectId: 'other-project' }),
    });
    await expect(stage(capability, validProvisioningIntent())).rejects.toThrow('Overseer approval staging is unavailable.');

    const withoutLength = createOverseerApprovalStageTransport({
      readToken: () => 'root-owned-token',
      fetchImpl: async () => responseFor(locator, 200, false),
    });
    await expect(withoutLength(capability, validProvisioningIntent())).rejects.toThrow('Overseer approval staging is unavailable.');
  });

  it('aborts a timed-out request and redacts transport failures', async () => {
    let observedSignal: AbortSignal | undefined;
    const stage = createOverseerApprovalStageTransport({
      readToken: () => 'private-root-token',
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(new Error('private request details')), { once: true });
        });
      },
    });

    await expect(stage(capability, validProvisioningIntent())).rejects.toThrow('Overseer approval staging is unavailable.');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('propagates workflow-host cancellation to the HTTP request', async () => {
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const stage = createOverseerApprovalStageTransport({
      readToken: () => 'root-owned-token',
      fetchImpl: async (_input, init) => {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        });
      },
    });
    const pending = stage(capability, validProvisioningIntent(), parent.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    parent.abort();
    await expect(pending).rejects.toThrow('Overseer approval staging is unavailable.');
    expect(observedSignal?.aborted).toBe(true);
  });
});
