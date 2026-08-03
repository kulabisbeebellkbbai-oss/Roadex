import { describe, expect, it } from 'vitest';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';

describe('approval workflow grant broker', () => {
  const scope = {
    userId: 'operator',
    sessionId: 'session-operator-123',
    workspaceId: 'roadex',
    managedThreadId: 'thread-operator-123',
    runId: 'run-operator-123',
  };

  it('issues bounded grants with exact session bindings and single use', () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue(scope);

    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(grant).toMatchObject(scope);
    expect(grant.expiresAt).toBe(new Date(1_000 + 300_000).toISOString());

    const consumed = broker.consume(grant.token);
    expect(consumed).toMatchObject(scope);
    expect(consumed?.token).toBe(grant.token);
    expect(consumed?.expiresAt).toBe(grant.expiresAt);
    expect(broker.consume(grant.token)).toBeUndefined();
  });

  it('enforces expiry and rejects malformed tokens', () => {
    let current = 1_000;
    const broker = new ApprovalWorkflowGrantBroker({ now: () => current });
    const grant = broker.issue(scope);

    current += 360_000;
    expect(broker.consume(grant.token)).toBeUndefined();
    expect(broker.consume('not-a-valid-token!!')).toBeUndefined();
  });

  it('revokes all grants for a run and keeps exact user/session/workspace/managetThread/run binding', () => {
    const broker = new ApprovalWorkflowGrantBroker();
    const first = broker.issue({ ...scope, runId: 'run-1', sessionId: 'session-1', managedThreadId: 'thread-1' });
    const second = broker.issue({ ...scope, runId: 'run-1', sessionId: 'session-2', managedThreadId: 'thread-2' });
    const unrelated = broker.issue({ ...scope, runId: 'run-2', sessionId: 'session-3', managedThreadId: 'thread-3' });

    broker.revokeRun('run-1');
    expect(broker.consume(first.token)).toBeUndefined();
    expect(broker.consume(second.token)).toBeUndefined();
    expect(broker.consume(unrelated.token)).toMatchObject({
      userId: 'operator',
      sessionId: 'session-3',
      workspaceId: 'roadex',
      managedThreadId: 'thread-3',
      runId: 'run-2',
    });
  });
});
