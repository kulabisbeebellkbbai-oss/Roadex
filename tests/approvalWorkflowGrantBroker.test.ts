import { describe, expect, it } from 'vitest';
import { ApprovalWorkflowGrantBroker } from '../src/server/approvalWorkflowGrantBroker';

const scope = {
  userId: 'owner',
  sessionId: 'session-123',
  workspaceId: 'roadex',
  managedThreadId: 'thread-123',
  runId: 'run-123',
};

describe('approval workflow grant broker', () => {
  it('issues one-time scope bound grants with five-minute expiry', () => {
    const broker = new ApprovalWorkflowGrantBroker({ now: () => 1_000 });
    const grant = broker.issue(scope);
    expect(grant).toMatchObject(scope);
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(grant.expiresAt).getTime()).toBe(301_000);
    expect(broker.consume(grant.token)).toMatchObject(scope);
    expect(broker.consume(grant.token)).toBeUndefined();
  });

  it('revokes all grants for a run without affecting other runs', () => {
    const broker = new ApprovalWorkflowGrantBroker();
    const first = broker.issue({ ...scope, runId: 'run-1' });
    const second = broker.issue({ ...scope, runId: 'run-2' });
    broker.revokeRun('run-1');
    expect(broker.consume(first.token)).toBeUndefined();
    expect(broker.consume(second.token)).toMatchObject({ runId: 'run-2' });
  });

  it('denies malformed tokens and replay after expiry', () => {
    let now = 0;
    const broker = new ApprovalWorkflowGrantBroker({
      now: () => now,
    });
    const grant = broker.issue(scope);
    expect(broker.consume('not-a-token')).toBeUndefined();
    expect(broker.consume('a'.repeat(42))).toBeUndefined();
    expect(broker.consume('a'.repeat(44))).toBeUndefined();
    expect(broker.consume(`${'a'.repeat(42)}.`)).toBeUndefined();
    expect(broker.consume(`${'A'.repeat(42)}B`)).toBeUndefined();
    now += 301_000;
    expect(broker.consume(grant.token)).toBeUndefined();
  });

  it('stores only a SHA-256 digest key and never stores the raw token in the grant value', () => {
    const broker = new ApprovalWorkflowGrantBroker();
    const grant = broker.issue(scope);
    const stored = (broker as unknown as {
      grants: Map<string, Record<string, unknown>>;
    }).grants;
    const entries = [...stored.entries()];

    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0][0]).not.toBe(grant.token);
    expect(JSON.stringify(entries[0][1])).not.toContain(grant.token);
    expect(entries[0][1]).not.toHaveProperty('token');
  });

  it('requires exact scope fields before storing grants', () => {
    const broker = new ApprovalWorkflowGrantBroker();
    expect(() => broker.issue({
      ...scope,
      userId: '../owner',
    })).toThrow('workflow_grant_invalid');
    expect(() => broker.issue({
      ...scope,
      sessionId: 'not valid',
    })).toThrow('workflow_grant_invalid');
    expect(() => broker.issue({
      ...scope,
      managedThreadId: '',
    })).toThrow('workflow_grant_invalid');
  });
});
