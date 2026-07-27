import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectCreationBroker, type TeamEvidence } from '../src/server/projectCreationBroker';
import type { UserProfile } from '../src/shared/sessionContracts';

const owner: UserProfile = {
  id: 'owner',
  displayName: 'Owner',
  authMode: 'protected-gateway',
  roles: ['user', 'admin', 'security-reviewer'],
};

const payload = {
  sessionId: 'session-1',
  projectName: 'Project Alpha',
  visibility: 'private',
  summary: {
    outcome: 'Create a managed project.',
    primaryUsers: 'Owner',
    majorComponents: ['Portal', 'Service'],
    risks: ['Privilege boundary'],
    immediateNextSteps: ['Implement locally'],
  },
  teamId: 'team-1',
  idempotencyKey: 'request-key-0001',
} as const;

function setup(overrides: NodeJS.ProcessEnv = {}) {
  let now = Date.parse('2026-07-25T00:00:00.000Z');
  let team: TeamEvidence = {
    id: 'team-1',
    title: 'Project Alpha',
    approvalStatus: 'approved',
    assignments: [{ status: 'approved' }],
  };
  let teamQueue: TeamEvidence[] = [];
  let sessionLifecycle = 'ready';
  const env = {
    ROADEX_PROJECT_CREATION_REQUEST_ENABLED: 'true',
    ROADEX_PROJECT_CREATION_CONFIRM_ENABLED: 'true',
    ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'false',
    ROADEX_PROJECT_CREATION_AUTHORIZED_USERS: 'owner',
    ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS: JSON.stringify([
      ['Project Alpha', 'team-1'],
    ]),
    ROADEX_PROJECT_CREATION_SOURCE_WORKSPACE_ID: 'ai-project-manager',
    ROADEX_PROJECT_CREATION_AUDIT_HMAC_KEY: 'test-audit-key-not-a-secret-32-bytes',
    ROADEX_PROJECT_CREATION_GITHUB_OWNER: 'owner-name',
    ROADEX_PROJECT_CREATION_WORKSPACE_ROOT: '/home/god/Documents/Codex Workspace',
    ...overrides,
  };
  const broker = new ProjectCreationBroker({
    resolveSession: (userId, sessionId) => userId === 'owner' && sessionId === 'session-1'
      ? {
          id: sessionId,
          userId,
          workspaceId: 'ai-project-manager',
          managedThreadId: 'thread-1',
          lifecycle: sessionLifecycle,
        }
      : undefined,
    resolveTeam: async () => teamQueue.shift() ?? team,
  }, {
    databasePath: ':memory:',
    env,
    now: () => now,
    random: () => Buffer.alloc(32, 7),
  });
  return {
    broker,
    advance: (milliseconds: number) => { now += milliseconds; },
    replaceTeam: (next: TeamEvidence) => { team = next; },
    queueTeams: (...next: TeamEvidence[]) => { teamQueue = [...next]; },
    setSessionLifecycle: (next: string) => { sessionLifecycle = next; },
  };
}

describe('ProjectCreationBroker', () => {
  it('migrates the reserved-only operation table without losing existing rows', () => {
    const databasePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'project-broker-')), 'state.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_name TEXT NOT NULL,
        visibility TEXT NOT NULL, summary_json TEXT NOT NULL, team_id TEXT NOT NULL,
        team_digest TEXT NOT NULL, request_key_digest TEXT NOT NULL,
        confirm_key_digest TEXT, challenge_digest TEXT, challenge_expires_at TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
        phase TEXT NOT NULL CHECK (phase='reserved'), created_at TEXT NOT NULL
      );
    `);
    legacy.close();
    const context = setup();
    expect(() => new ProjectCreationBroker({
      resolveSession: () => undefined,
      resolveTeam: async () => undefined,
    }, {
      databasePath,
      env: {
        ROADEX_PROJECT_CREATION_AUDIT_HMAC_KEY: 'test-audit-key-not-a-secret-32-bytes',
      },
    })).not.toThrow();
    expect(context.broker.executionEnabled()).toBe(false);
  });

  it('defaults request and confirmation gates off', async () => {
    const { broker } = setup({
      ROADEX_PROJECT_CREATION_REQUEST_ENABLED: 'TRUE',
      ROADEX_PROJECT_CREATION_CONFIRM_ENABLED: '1',
    });
    expect(await broker.createProposal(owner, payload)).toBeUndefined();
  });

  it('requires exact owner roles, allowlist, and a dedicated strong audit key', async () => {
    const { broker } = setup({ ROADEX_PROJECT_CREATION_AUDIT_HMAC_KEY: 'short' });
    expect(await broker.createProposal(owner, payload)).toBeUndefined();
    const valid = setup().broker;
    expect(await valid.createProposal(
      { ...owner, roles: ['user', 'security-reviewer'] },
      payload,
    )).toBeUndefined();
    expect(await valid.createProposal({ ...owner, id: 'other' }, payload)).toBeUndefined();
  });

  it('requires an exact configured project-to-approved-team binding', async () => {
    const missing = setup({ ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS: '' });
    expect(await missing.broker.createProposal(owner, payload)).toBeUndefined();

    const malformed = setup({ ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS: '{"Project Alpha":"team-1"}' });
    expect(await malformed.broker.createProposal(owner, payload)).toBeUndefined();

    const invalidTeamId = setup({
      ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS: JSON.stringify([
        ['Project Alpha', 'team id'],
      ]),
    });
    expect(await invalidTeamId.broker.createProposal(owner, {
      ...payload,
      teamId: 'team id',
    })).toBeUndefined();

    const mismatch = setup({
      ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS: JSON.stringify([
        ['Project Alpha', 'team-other'],
      ]),
    });
    expect(await mismatch.broker.createProposal(owner, payload)).toBeUndefined();

    const duplicate = setup({
      ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS: JSON.stringify([
        ['Project Alpha', 'team-1'],
        ['Project Alpha', 'team-other'],
      ]),
    });
    expect(await duplicate.broker.createProposal(owner, payload)).toBeUndefined();

    const { broker, replaceTeam } = setup();
    replaceTeam({
      id: 'team-1',
      title: 'Royal Court of Princess Donut',
      approvalStatus: 'approved',
      assignments: [{ status: 'approved' }],
    });
    expect(await broker.createProposal(owner, payload)).toMatchObject({
      projectName: 'Project Alpha',
      status: 'pending',
    });
  });

  it('creates, challenges, and atomically consumes one exact proposal', async () => {
    const { broker } = setup();
    const proposal = await broker.createProposal(owner, payload);
    expect(proposal).toMatchObject({
      projectName: 'Project Alpha',
      visibility: 'private',
      status: 'pending',
    });
    expect(proposal).not.toHaveProperty('userId');
    expect(proposal).not.toHaveProperty('teamId');
    expect(proposal).not.toHaveProperty('summary');

    const challenge = await broker.createChallenge(owner, proposal!.id);
    const confirmed = await broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-0001',
    });
    expect(confirmed).toMatchObject({
      status: 'consumed',
      operation: { phase: 'reserved' },
    });

    expect(await broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-0001',
    })).toEqual(confirmed);
    expect(await broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'different-confirm-key',
    })).toBeUndefined();
    expect(broker.executionEnabled()).toBe(false);
  });

  it('allows only one concurrent confirmation to create an operation', async () => {
    const { broker } = setup();
    const proposal = await broker.createProposal(owner, payload);
    const challenge = await broker.createChallenge(owner, proposal!.id);
    const results = await Promise.all([
      broker.confirm(owner, proposal!.id, {
        challenge: challenge!.challenge,
        idempotencyKey: 'confirm-key-0001',
      }),
      broker.confirm(owner, proposal!.id, {
        challenge: challenge!.challenge,
        idempotencyKey: 'confirm-key-0002',
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rejects traversal, unknown fields, cross-user access, and team drift', async () => {
    const { broker, replaceTeam } = setup();
    expect(await broker.createProposal(owner, { ...payload, projectName: '../Project' })).toBeUndefined();
    expect(await broker.createProposal(owner, { ...payload, path: '/tmp/project' })).toBeUndefined();

    const proposal = await broker.createProposal(owner, payload);
    const other = { ...owner, id: 'other' };
    expect(broker.get(other, proposal!.id)).toBeUndefined();
    const challenge = await broker.createChallenge(owner, proposal!.id);
    replaceTeam({
      id: 'team-1',
      title: 'Project Alpha',
      approvalStatus: 'approved',
      assignments: [{ status: 'done' }],
    });
    expect(await broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-0001',
    })).toBeUndefined();
  });

  it('expires challenges and permits idempotent pre-consumption revocation', async () => {
    const { broker, advance } = setup();
    const proposal = await broker.createProposal(owner, payload);
    const challenge = await broker.createChallenge(owner, proposal!.id);
    advance(3 * 60_000);
    expect(await broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-0001',
    })).toBeUndefined();
    const revoked = broker.revoke(owner, proposal!.id);
    expect(revoked?.status).toBe('revoked');
    expect(broker.revoke(owner, proposal!.id)).toEqual(revoked);
  });

  it('reports proposal expiry and refuses revocation after expiry', async () => {
    const { broker, advance } = setup();
    const proposal = await broker.createProposal(owner, payload);
    advance(11 * 60_000);
    expect(broker.get(owner, proposal!.id)?.status).toBe('expired');
    expect(broker.revoke(owner, proposal!.id)).toBeUndefined();
  });

  it('leases one consumed operation only when execution is independently enabled', async () => {
    const disabled = setup();
    const disabledProposal = await disabled.broker.createProposal(owner, payload);
    const disabledChallenge = await disabled.broker.createChallenge(owner, disabledProposal!.id);
    await disabled.broker.confirm(owner, disabledProposal!.id, {
      challenge: disabledChallenge!.challenge,
      idempotencyKey: 'confirm-key-disabled',
    });
    expect(await disabled.broker.claimExecution(owner, disabledProposal!.id)).toBeUndefined();

    const enabled = setup({ ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'true' });
    const proposal = await enabled.broker.createProposal(owner, payload);
    const challenge = await enabled.broker.createChallenge(owner, proposal!.id);
    await enabled.broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-enabled',
    });
    const lease = await enabled.broker.claimExecution(owner, proposal!.id);
    expect(lease).toMatchObject({
      proposalId: proposal!.id,
      startPhase: 'reserved',
      spec: {
        projectName: 'Project Alpha',
        githubOwner: 'owner-name',
        workspaceRoot: '/home/god/Documents/Codex Workspace',
      },
    });
    expect(await enabled.broker.claimExecution(owner, proposal!.id)).toBeUndefined();
  });

  it('renders the same live team object that passed digest revalidation', async () => {
    const context = setup({ ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'true' });
    const proposal = await context.broker.createProposal(owner, payload);
    const challenge = await context.broker.createChallenge(owner, proposal!.id);
    await context.broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-team-snapshot',
    });
    const original = {
      id: 'team-1',
      title: 'Project Alpha',
      approvalStatus: 'approved' as const,
      assignments: [{ status: 'approved' }],
    };
    const substituted = {
      ...original,
      title: 'substituted',
    };
    context.queueTeams(substituted, original, original);
    const lease = await context.broker.claimExecution(owner, proposal!.id);
    expect(lease).toBeUndefined();
  });

  it('revalidates ownership evidence and resumes after an expired or failed lease', async () => {
    const context = setup({ ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'true' });
    const proposal = await context.broker.createProposal(owner, payload);
    const challenge = await context.broker.createChallenge(owner, proposal!.id);
    await context.broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-resume',
    });
    const first = await context.broker.claimExecution(owner, proposal!.id);
    expect(first).toBeDefined();
    expect(await context.broker.advanceExecution(
      owner, first!.operationId, first!.leaseToken, 'local-prepared',
    )).toBe(true);
    expect(await context.broker.advanceExecution(
      owner, first!.operationId, first!.leaseToken, 'failed-retryable', 'remote_unavailable',
    )).toBe(true);
    const resumed = await context.broker.claimExecution(owner, proposal!.id);
    expect(resumed?.startPhase).toBe('local-prepared');

    context.advance(11 * 60_000);
    const expiredLeaseReplacement = await context.broker.claimExecution(owner, proposal!.id);
    expect(expiredLeaseReplacement?.operationId).toBe(first!.operationId);
    context.setSessionLifecycle('closed');
    context.advance(11 * 60_000);
    expect(await context.broker.claimExecution(owner, proposal!.id)).toBeUndefined();
  });

  it('enforces ordered phases and rejects stale lease credentials', async () => {
    const context = setup({ ROADEX_PROJECT_CREATION_EXECUTION_ENABLED: 'true' });
    const proposal = await context.broker.createProposal(owner, payload);
    const challenge = await context.broker.createChallenge(owner, proposal!.id);
    await context.broker.confirm(owner, proposal!.id, {
      challenge: challenge!.challenge,
      idempotencyKey: 'confirm-key-phases',
    });
    const lease = await context.broker.claimExecution(owner, proposal!.id);
    expect(await context.broker.advanceExecution(
      owner, lease!.operationId, 'wrong-token-value-that-is-long-enough', 'local-prepared',
    )).toBe(false);
    expect(await context.broker.advanceExecution(
      owner, lease!.operationId, lease!.leaseToken, 'pushed',
    )).toBe(false);
    for (const phase of ['local-prepared', 'remote-created', 'pushed', 'thread-started', 'completed'] as const) {
      expect(await context.broker.advanceExecution(owner, lease!.operationId, lease!.leaseToken, phase)).toBe(true);
    }
    expect((await context.broker.get(owner, proposal!.id))?.operation?.phase).toBe('completed');
  });
});
