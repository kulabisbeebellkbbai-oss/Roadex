import { describe, expect, it } from 'vitest';
import {
  createProductionApprovalWorkflowHostDependencies,
  createProductionApprovalWorkflowRuntime,
} from '../src/server/approvalWorkflowComposition';

describe('production approval workflow composition', () => {
  it('passes the real Overseer staging transport to the host without starting services', () => {
    const broker = {
      issue: () => ({
        token: 'A'.repeat(43),
        userId: 'owner',
        sessionId: 'session-1',
        workspaceId: 'roadex',
        managedThreadId: 'thread-1',
        runId: 'run-1',
        expiresAt: '2026-08-04T00:00:00.000Z',
      }),
      consume: () => undefined,
      revokeRun: () => undefined,
    };
    const runtime = createProductionApprovalWorkflowRuntime(broker, {
      readToken: () => 'root-owned-token',
      fetchImpl: async () => new Response('{}', { status: 503, headers: { 'content-length': '2' } }),
    });
    const dependencies = createProductionApprovalWorkflowHostDependencies({
      broker,
      runtime,
      registerApprovalWait: async () => ({
        ok: false,
        reason: 'scope_mismatch',
      }),
    });

    expect(dependencies.stageTypedIntent).toBe(runtime.stageTypedIntent);
    expect(dependencies.stageTypedIntent).toEqual(expect.any(Function));
  });
});
