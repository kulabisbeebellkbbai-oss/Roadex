import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { ControlledRunnerGrant } from './runnerCapabilityProfile.js';
import type {
  ProjectCreationChallengePublic,
  ProjectCreationConfirmPayload,
  ProjectCreationProposalPayload,
  ProjectCreationProposalPublic,
  ProjectCreationOperationPhase,
  ProjectSummary,
  ProjectVisibility,
} from '../shared/projectCreationContracts.js';
import {
  projectCreationConfirmEnabled,
  projectCreationExecutionEnabled,
  projectCreationRequestEnabled,
} from './projectCreationPolicy.js';

type SessionEvidence = {
  id: string;
  userId: string;
  workspaceId: string;
  managedThreadId?: string;
  lifecycle: string;
};

export type TeamEvidence = {
  id: string;
  title: string;
  approvalStatus: string;
  assignments?: Array<{ status?: string }>;
  [key: string]: unknown;
};

type BrokerDependencies = {
  resolveSession: (userId: string, sessionId: string) => SessionEvidence | undefined;
  resolveTeam: (teamId: string) => Promise<TeamEvidence | undefined>;
};

type BrokerOptions = {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  random?: (bytes: number) => Buffer;
};

type ProposalRow = {
  id: string;
  user_id: string;
  session_id: string;
  thread_id: string;
  workspace_id: string;
  project_name: string;
  visibility: ProjectVisibility;
  summary_json: string;
  team_id: string;
  team_digest: string;
  request_key_digest: string;
  confirm_key_digest: string | null;
  challenge_digest: string | null;
  challenge_expires_at: string | null;
  status: ProjectCreationProposalPublic['status'];
  created_at: string;
  expires_at: string;
};

type OperationRow = {
  id: string;
  proposal_id: string;
  phase: ProjectCreationOperationPhase;
  resume_phase: Exclude<ProjectCreationOperationPhase, 'failed-retryable' | 'reconcile-required'> | null;
  lease_digest: string | null;
  lease_expires_at: string | null;
  failure_class: string | null;
  workspace_id: string | null;
  workspace_root: string | null;
  managed_thread_id: string | null;
  created_at: string;
  updated_at: string;
};

type ControlledRunnerGrantRow = {
  id: string;
  operation_id: string;
  user_id: string;
  workspace_id: string;
  workspace_root: string;
  managed_thread_id: string;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
};

export type ControlledRunnerGrantEvidence = {
  workspaceId: string;
  workspaceRoot: string;
  managedThreadId: string;
};

export type ControlledRunnerGrantContext = {
  userId: string;
  workspaceId: string;
  workspaceRoot: string;
  managedThreadId?: string;
  codexThreadId?: string;
};

export type ProjectCreationExecutionLease = {
  operationId: string;
  proposalId: string;
  leaseToken: string;
  startPhase: Exclude<ProjectCreationOperationPhase, 'failed-retryable' | 'reconcile-required'>;
  spec: {
    operationId: string;
    projectName: string;
    visibility: ProjectVisibility;
    githubOwner: string;
    workspaceRoot: string;
    summaryMarkdown: string;
    aTeamPlanMarkdown: string;
  };
};

export class ProjectCreationBroker {
  readonly #db: DatabaseSync;
  readonly #deps: BrokerDependencies;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;

  constructor(dependencies: BrokerDependencies, options: BrokerOptions = {}) {
    this.#deps = dependencies;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#db = new DatabaseSync(options.databasePath ?? this.#env.ROADEX_PROJECT_CREATION_STATE_PATH ?? 'data/project-creation.sqlite');
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        project_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
        summary_json TEXT NOT NULL, team_id TEXT NOT NULL, team_digest TEXT NOT NULL,
        request_key_digest TEXT NOT NULL UNIQUE, confirm_key_digest TEXT UNIQUE,
        challenge_digest TEXT, challenge_expires_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','consumed','revoked','expired')),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
        phase TEXT NOT NULL, resume_phase TEXT, lease_digest TEXT,
        lease_expires_at TEXT, failure_class TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_creation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL,
        actor_tag TEXT NOT NULL, resource_tag TEXT NOT NULL, outcome TEXT NOT NULL,
        classification TEXT NOT NULL
      );
    `);
    this.#migrateLegacyOperations();
    this.#ensureControlledRunnerGrantSchema();
  }

  async createProposal(user: UserProfile, payload: unknown): Promise<ProjectCreationProposalPublic | undefined> {
    if (!projectCreationRequestEnabled(this.#env) || !this.#authorized(user)) return undefined;
    const parsed = parseProposal(payload);
    if (!parsed) return undefined;
    const existing = this.#proposalByRequestKey(digest(parsed.idempotencyKey));
    if (existing) return existing.user_id === user.id ? this.#publicProposal(existing) : undefined;
    const session = this.#validSession(user, parsed.sessionId);
    const team = await this.#validTeam(parsed.teamId, parsed.projectName);
    if (!session || !team) return undefined;
    const now = this.#now();
    const row: ProposalRow = {
      id: `project-proposal-${randomUUID()}`,
      user_id: user.id,
      session_id: session.id,
      thread_id: session.managedThreadId!,
      workspace_id: session.workspaceId,
      project_name: parsed.projectName,
      visibility: parsed.visibility,
      summary_json: JSON.stringify(parsed.summary),
      team_id: team.id,
      team_digest: digest(stableJson(team)),
      request_key_digest: digest(parsed.idempotencyKey),
      confirm_key_digest: null,
      challenge_digest: null,
      challenge_expires_at: null,
      status: 'pending',
      created_at: iso(now),
      expires_at: iso(now + 10 * 60_000),
    };
    const created = this.#transaction(() => {
      this.#db.prepare(`
          INSERT INTO proposals VALUES (
            @id,@user_id,@session_id,@thread_id,@workspace_id,@project_name,@visibility,
            @summary_json,@team_id,@team_digest,@request_key_digest,@confirm_key_digest,
            @challenge_digest,@challenge_expires_at,@status,@created_at,@expires_at
          )
        `).run(row);
      this.#audit(user.id, row.id, 'proposal.request', 'allowed', 'created');
      return this.#publicProposal(row);
    });
    if (created) return created;
    const raced = this.#proposalByRequestKey(row.request_key_digest);
    return raced?.user_id === user.id ? this.#publicProposal(raced) : undefined;
  }

  async createChallenge(user: UserProfile, proposalId: string): Promise<ProjectCreationChallengePublic | undefined> {
    if (!projectCreationConfirmEnabled(this.#env) || !this.#authorized(user)) return undefined;
    const row = this.#proposal(proposalId);
    if (!row || row.user_id !== user.id || row.status !== 'pending' || expired(row.expires_at, this.#now())) return undefined;
    if (!(await this.#revalidate(user, row))) return undefined;
    const challenge = this.#random(32).toString('base64url');
    const expiresAt = iso(this.#now() + 2 * 60_000);
    return this.#transaction(() => {
      this.#db.prepare(`
        UPDATE proposals SET challenge_digest=?, challenge_expires_at=?
        WHERE id=? AND status='pending'
      `).run(digest(challenge), expiresAt, row.id);
      this.#audit(user.id, row.id, 'proposal.challenge', 'allowed', 'issued');
      return { proposalId: row.id, challenge, expiresAt };
    });
  }

  async confirm(
    user: UserProfile,
    proposalId: string,
    payload: unknown,
  ): Promise<ProjectCreationProposalPublic | undefined> {
    if (!projectCreationConfirmEnabled(this.#env) || !this.#authorized(user)) return undefined;
    const parsed = parseConfirm(payload);
    if (!parsed) return undefined;
    const initial = this.#proposal(proposalId);
    if (!initial || initial.user_id !== user.id) return undefined;
    const keyDigest = digest(parsed.idempotencyKey);
    if (initial.status === 'consumed' && initial.confirm_key_digest === keyDigest) {
      return this.#publicProposal(initial);
    }
    if (
      initial.status !== 'pending'
      || expired(initial.expires_at, this.#now())
      || !initial.challenge_digest
      || !initial.challenge_expires_at
      || expired(initial.challenge_expires_at, this.#now())
      || !timingSafeDigest(initial.challenge_digest, parsed.challenge)
      || !(await this.#revalidate(user, initial))
    ) return undefined;

    return this.#transaction(() => {
      const current = this.#proposal(proposalId);
      if (current?.status === 'consumed' && current.confirm_key_digest === keyDigest) {
        return this.#publicProposal(current);
      }
      if (!current || current.status !== 'pending' || current.challenge_digest !== initial.challenge_digest) {
        throw new Error('stale');
      }
      const operation: OperationRow = {
        id: `project-operation-${randomUUID()}`,
        proposal_id: current.id,
        phase: 'reserved',
        resume_phase: null,
        lease_digest: null,
        lease_expires_at: null,
        failure_class: null,
        workspace_id: null,
        workspace_root: null,
        managed_thread_id: null,
        created_at: iso(this.#now()),
        updated_at: iso(this.#now()),
      };
      this.#db.prepare(`
        INSERT INTO operations(
          id,proposal_id,phase,resume_phase,lease_digest,lease_expires_at,
          failure_class,workspace_id,workspace_root,managed_thread_id,created_at,updated_at
        ) VALUES (
          @id,@proposal_id,@phase,@resume_phase,@lease_digest,@lease_expires_at,
          @failure_class,@workspace_id,@workspace_root,@managed_thread_id,@created_at,@updated_at
        )
      `).run(operation);
      this.#db.prepare(`
        UPDATE proposals SET status='consumed', confirm_key_digest=?,
        challenge_digest=NULL, challenge_expires_at=NULL WHERE id=?
      `).run(keyDigest, current.id);
      this.#audit(user.id, current.id, 'proposal.confirm', 'allowed', 'consumed');
      return this.#publicProposal(this.#proposal(current.id)!);
    });
  }

  revoke(user: UserProfile, proposalId: string): ProjectCreationProposalPublic | undefined {
    if (!projectCreationRequestEnabled(this.#env) || !this.#authorized(user)) return undefined;
    const row = this.#proposal(proposalId);
    if (!row || row.user_id !== user.id) return undefined;
    if (row.status === 'revoked') return this.#publicProposal(row);
    if (row.status !== 'pending' || expired(row.expires_at, this.#now())) return undefined;
    return this.#transaction(() => {
      this.#db.prepare(`
        UPDATE proposals SET status='revoked', challenge_digest=NULL,
        challenge_expires_at=NULL WHERE id=? AND status='pending'
      `).run(row.id);
      this.#audit(user.id, row.id, 'proposal.revoke', 'allowed', 'revoked');
      return this.#publicProposal(this.#proposal(row.id)!);
    });
  }

  get(user: UserProfile, proposalId: string): ProjectCreationProposalPublic | undefined {
    if (!projectCreationRequestEnabled(this.#env) || !this.#authorized(user)) return undefined;
    const row = this.#proposal(proposalId);
    return row?.user_id === user.id ? this.#publicProposal(row) : undefined;
  }

  executionEnabled(): boolean {
    return projectCreationExecutionEnabled(this.#env);
  }

  async claimExecution(user: UserProfile, proposalId: string): Promise<ProjectCreationExecutionLease | undefined> {
    if (!this.executionEnabled() || !this.#authorized(user)) return undefined;
    const proposal = this.#proposal(proposalId);
    if (!proposal || proposal.user_id !== user.id || proposal.status !== 'consumed') return undefined;
    if (!(await this.#revalidate(user, proposal))) return undefined;
    const githubOwner = validGithubOwner(this.#env.ROADEX_PROJECT_CREATION_GITHUB_OWNER);
    const workspaceRoot = this.#env.ROADEX_PROJECT_CREATION_WORKSPACE_ROOT;
    if (!githubOwner || workspaceRoot !== '/home/god/Documents/Codex Workspace') return undefined;
    const leaseToken = this.#random(32).toString('base64url');
    const now = this.#now();
    const leaseExpiresAt = iso(now + 10 * 60_000);
    const operation = this.#transaction(() => {
      const active = this.#db.prepare(`
        SELECT id FROM operations WHERE lease_expires_at IS NOT NULL AND lease_expires_at > ? LIMIT 1
      `).get(iso(now)) as { id: string } | undefined;
      if (active) throw new Error('worker_busy');
      const current = this.#operationByProposal(proposal.id);
      if (
        !current
        || ['completed', 'reconcile-required'].includes(current.phase)
        || (current.lease_expires_at && !expired(current.lease_expires_at, now))
      ) throw new Error('not_claimable');
      const startPhase = current.phase === 'failed-retryable' ? current.resume_phase : current.phase;
      if (!startPhase || startPhase === 'completed') throw new Error('invalid_resume');
      this.#db.prepare(`
        UPDATE operations SET phase=?, resume_phase=NULL, lease_digest=?,
          lease_expires_at=?, failure_class=NULL, updated_at=? WHERE id=?
      `).run(startPhase, digest(leaseToken), leaseExpiresAt, iso(now), current.id);
      this.#audit(user.id, current.id, 'operation.lease', 'allowed', 'leased');
      return { ...current, phase: startPhase };
    });
    if (!operation) return undefined;
    const team = await this.#revalidate(user, proposal);
    if (!team) {
      this.#transaction(() => {
        const update = this.#db.prepare(`
          UPDATE operations SET lease_digest=NULL, lease_expires_at=NULL,
            updated_at=? WHERE id=? AND lease_digest=?
        `).run(iso(this.#now()), operation.id, digest(leaseToken));
        if (update.changes !== 1) throw new Error('lease_release_failed');
        this.#audit(user.id, operation.id, 'operation.lease', 'denied', 'evidence_changed');
      });
      return undefined;
    }
    const summary = JSON.parse(proposal.summary_json) as ProjectSummary;
    return {
      operationId: operation.id,
      proposalId: proposal.id,
      leaseToken,
      startPhase: operation.phase as ProjectCreationExecutionLease['startPhase'],
      spec: {
        operationId: operation.id,
        projectName: proposal.project_name,
        visibility: proposal.visibility,
        githubOwner,
        workspaceRoot,
        summaryMarkdown: renderSummary(proposal.project_name, summary),
        aTeamPlanMarkdown: renderTeam(team),
      },
    };
  }

  async advanceExecution(
    user: UserProfile,
    operationId: string,
    leaseToken: string,
    nextPhase: ProjectCreationOperationPhase,
    failureClass?: string,
    grantEvidence?: ControlledRunnerGrantEvidence,
  ): Promise<boolean> {
    if (!this.executionEnabled() || !this.#authorized(user)) return false;
    const operation = this.#operation(operationId);
    if (!operation) return false;
    const proposal = this.#proposal(operation.proposal_id);
    if (!proposal || proposal.user_id !== user.id || !(await this.#revalidate(user, proposal))) return false;
    if (!operation.lease_digest || !timingSafeDigest(operation.lease_digest, leaseToken)) return false;
    if (!operation.lease_expires_at || expired(operation.lease_expires_at, this.#now())) return false;
    const classification = failureClass ? validFailureClass(failureClass) : undefined;
    if (failureClass && !classification) return false;
    if (grantEvidence && nextPhase !== 'thread-started') return false;
    const verifiedEvidence = nextPhase === 'thread-started'
      ? validGrantEvidence(
        grantEvidence,
        join(this.#env.ROADEX_PROJECT_CREATION_WORKSPACE_ROOT ?? '', proposal.project_name),
      )
      : undefined;
    if (nextPhase === 'thread-started' && !verifiedEvidence) return false;
    if (
      nextPhase === 'completed'
      && !validStoredGrantEvidence(operation)
    ) return false;
    const allowed = nextPhase === 'failed-retryable'
      || nextPhase === 'reconcile-required'
      || nextExecutionPhase(operation.phase) === nextPhase;
    if (!allowed) return false;
    return Boolean(this.#transaction(() => {
      const terminal = ['completed', 'reconcile-required', 'failed-retryable'].includes(nextPhase);
      const update = this.#db.prepare(`
        UPDATE operations SET phase=?, resume_phase=?, lease_digest=?, lease_expires_at=?,
          failure_class=?, workspace_id=?, workspace_root=?, managed_thread_id=?,
          updated_at=? WHERE id=? AND lease_digest=?
      `).run(
        nextPhase,
        nextPhase === 'failed-retryable' ? operation.phase : null,
        terminal ? null : operation.lease_digest,
        terminal ? null : operation.lease_expires_at,
        classification ?? null,
        verifiedEvidence?.workspaceId ?? operation.workspace_id,
        verifiedEvidence?.workspaceRoot ?? operation.workspace_root,
        verifiedEvidence?.managedThreadId ?? operation.managed_thread_id,
        iso(this.#now()),
        operation.id,
        operation.lease_digest,
      );
      if (update.changes !== 1) throw new Error('stale_lease');
      if (nextPhase === 'completed') {
        this.#db.prepare(`
          INSERT INTO controlled_runner_grants(
            id,operation_id,user_id,workspace_id,workspace_root,managed_thread_id,
            status,created_at,revoked_at
          ) VALUES(?,?,?,?,?,?,'active',?,NULL)
        `).run(
          `controlled-grant-${operation.id}`,
          operation.id,
          proposal.user_id,
          operation.workspace_id,
          operation.workspace_root,
          operation.managed_thread_id,
          iso(this.#now()),
        );
      }
      this.#audit(user.id, operation.id, 'operation.phase', 'allowed', nextPhase);
      return true;
    }));
  }

  resolveControlledRunnerGrant(context: ControlledRunnerGrantContext): ControlledRunnerGrant | undefined {
    if (
      !validIdentifier(context.userId)
      || !validIdentifier(context.workspaceId)
      || !validRoot(context.workspaceRoot)
      || !validIdentifier(context.managedThreadId)
      || context.managedThreadId !== context.codexThreadId
    ) return undefined;
    const row = this.#db.prepare(`
      SELECT grants.* FROM controlled_runner_grants AS grants
      JOIN operations ON operations.id=grants.operation_id
      JOIN proposals ON proposals.id=operations.proposal_id
      WHERE grants.user_id=? AND grants.workspace_id=? AND grants.workspace_root=?
        AND grants.managed_thread_id=? AND grants.status='active'
        AND operations.phase='completed' AND proposals.status='consumed'
      LIMIT 1
    `).get(
      context.userId,
      context.workspaceId,
      context.workspaceRoot,
      context.managedThreadId,
    ) as ControlledRunnerGrantRow | undefined;
    return row ? publicControlledRunnerGrant(row) : undefined;
  }

  revokeControlledRunnerGrant(operationId: string, actorId: string): boolean {
    if (!validIdentifier(operationId) || !validIdentifier(actorId)) return false;
    return Boolean(this.#transaction(() => {
      const update = this.#db.prepare(`
        UPDATE controlled_runner_grants SET status='revoked', revoked_at=?
        WHERE operation_id=? AND status='active'
      `).run(iso(this.#now()), operationId);
      if (update.changes !== 1) throw new Error('grant_not_active');
      this.#audit(actorId, operationId, 'controlled_runner.revoke', 'allowed', 'revoked');
      return true;
    }));
  }

  #authorized(user: UserProfile): boolean {
    const users = new Set((this.#env.ROADEX_PROJECT_CREATION_AUTHORIZED_USERS ?? '').split(',').map((v) => v.trim()).filter(Boolean));
    return user.authMode === 'protected-gateway'
      && user.roles.includes('admin')
      && user.roles.includes('security-reviewer')
      && users.has(user.id)
      && (this.#env.ROADEX_PROJECT_CREATION_AUDIT_HMAC_KEY?.length ?? 0) >= 32;
  }

  #validSession(user: UserProfile, sessionId: string): SessionEvidence | undefined {
    const session = this.#deps.resolveSession(user.id, sessionId);
    const workspace = this.#env.ROADEX_PROJECT_CREATION_SOURCE_WORKSPACE_ID;
    return session
      && session.userId === user.id
      && session.workspaceId === workspace
      && session.lifecycle === 'ready'
      && session.managedThreadId
      ? session
      : undefined;
  }

  async #validTeam(teamId: string, projectName: string): Promise<TeamEvidence | undefined> {
    const approvedTeamId = approvedTeamBindings(this.#env)?.get(projectName);
    if (approvedTeamId !== teamId) return undefined;
    const team = await this.#deps.resolveTeam(teamId);
    return team
      && team.id === teamId
      && team.approvalStatus === 'approved'
      && !(team.assignments ?? []).some((assignment) => assignment.status === 'draft')
      ? team
      : undefined;
  }

  async #revalidate(user: UserProfile, row: ProposalRow): Promise<TeamEvidence | undefined> {
    const session = this.#validSession(user, row.session_id);
    const team = await this.#validTeam(row.team_id, row.project_name);
    return (
      session
      && session.managedThreadId === row.thread_id
      && team
      && digest(stableJson(team)) === row.team_digest
    ) ? team : undefined;
  }

  #proposal(id: string): ProposalRow | undefined {
    return this.#db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as ProposalRow | undefined;
  }

  #proposalByRequestKey(key: string): ProposalRow | undefined {
    return this.#db.prepare('SELECT * FROM proposals WHERE request_key_digest=?').get(key) as ProposalRow | undefined;
  }

  #operation(id: string): OperationRow | undefined {
    return this.#db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow | undefined;
  }

  #operationByProposal(proposalId: string): OperationRow | undefined {
    return this.#db.prepare('SELECT * FROM operations WHERE proposal_id=?').get(proposalId) as OperationRow | undefined;
  }

  #publicProposal(row: ProposalRow): ProjectCreationProposalPublic {
    const operation = this.#db.prepare('SELECT * FROM operations WHERE proposal_id=?').get(row.id) as OperationRow | undefined;
    return {
      id: row.id,
      projectName: row.project_name,
      visibility: row.visibility,
      status: row.status === 'pending' && expired(row.expires_at, this.#now()) ? 'expired' : row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      operation: operation ? { id: operation.id, phase: operation.phase, createdAt: operation.created_at } : undefined,
    };
  }

  #audit(actor: string, resource: string, action: string, outcome: string, classification: string): void {
    const key = this.#env.ROADEX_PROJECT_CREATION_AUDIT_HMAC_KEY!;
    this.#db.prepare(`
      INSERT INTO project_creation_audit(at,action,actor_tag,resource_tag,outcome,classification)
      VALUES(?,?,?,?,?,?)
    `).run(iso(this.#now()), action, tag(key, actor), tag(key, resource), outcome, classification);
  }

  #transaction<T>(action: () => T): T | undefined {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch {
      this.#db.exec('ROLLBACK');
      return undefined;
    }
  }

  #migrateLegacyOperations(): void {
    const columns = this.#db.prepare('PRAGMA table_info(operations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'updated_at')) {
      this.#db.exec(`
        ALTER TABLE operations RENAME TO operations_legacy;
        CREATE TABLE operations (
          id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
          phase TEXT NOT NULL, resume_phase TEXT, lease_digest TEXT,
          lease_expires_at TEXT, failure_class TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO operations(id,proposal_id,phase,created_at,updated_at)
          SELECT id,proposal_id,phase,created_at,created_at FROM operations_legacy;
        DROP TABLE operations_legacy;
      `);
    }
  }

  #ensureControlledRunnerGrantSchema(): void {
    const columns = this.#db.prepare('PRAGMA table_info(operations)').all() as Array<{ name: string }>;
    for (const name of ['workspace_id', 'workspace_root', 'managed_thread_id']) {
      if (!columns.some((column) => column.name === name)) {
        this.#db.exec(`ALTER TABLE operations ADD COLUMN ${name} TEXT`);
      }
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS controlled_runner_grants (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        managed_thread_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active','revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS controlled_runner_grant_lookup
        ON controlled_runner_grants(user_id,workspace_id,workspace_root,managed_thread_id,status);
    `);
  }
}

function parseProposal(value: unknown): ProjectCreationProposalPayload | undefined {
  if (!exactObject(value, ['sessionId', 'projectName', 'visibility', 'summary', 'teamId', 'idempotencyKey'])) return undefined;
  const summary = value.summary;
  if (!exactObject(summary, ['outcome', 'primaryUsers', 'majorComponents', 'risks', 'immediateNextSteps'])) return undefined;
  const projectName = validProjectName(value.projectName);
  const visibility = value.visibility === 'public' || value.visibility === 'private' ? value.visibility : undefined;
  if (
    !projectName || !visibility || !bounded(value.sessionId, 128) || !validTeamId(value.teamId)
    || !bounded(value.idempotencyKey, 128, 16) || !bounded(summary.outcome, 2_000)
    || !bounded(summary.primaryUsers, 2_000) || !boundedArray(summary.majorComponents)
    || !boundedArray(summary.risks) || !boundedArray(summary.immediateNextSteps)
  ) return undefined;
  return {
    sessionId: value.sessionId,
    projectName,
    visibility,
    teamId: value.teamId,
    idempotencyKey: value.idempotencyKey,
    summary: summary as ProjectSummary,
  };
}

function approvedTeamBindings(env: NodeJS.ProcessEnv): Map<string, string> | undefined {
  const raw = env.ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS;
  if (!raw || raw.length > 16_384) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) return undefined;
    const bindings = new Map<string, string>();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) return undefined;
      const [projectName, teamId] = entry;
      if (typeof projectName !== 'string') return undefined;
      const normalizedProject = validProjectName(projectName);
      if (
        normalizedProject !== projectName
        || !validTeamId(teamId)
        || bindings.has(projectName)
      ) return undefined;
      bindings.set(projectName, teamId);
    }
    return bindings;
  } catch {
    return undefined;
  }
}

function parseConfirm(value: unknown): ProjectCreationConfirmPayload | undefined {
  return exactObject(value, ['challenge', 'idempotencyKey'])
    && bounded(value.challenge, 128, 32)
    && bounded(value.idempotencyKey, 128, 16)
    ? { challenge: value.challenge, idempotencyKey: value.idempotencyKey }
    : undefined;
}

function validProjectName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 80) return undefined;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9])?$/.test(value)) return undefined;
  if (value === '.' || value === '..' || /[._ -]{2}/.test(value)) return undefined;
  return value;
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'));
}

function bounded(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function boundedArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((item) => bounded(item, 1_000));
}

function validTeamId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeDigest(expected: string, value: string): boolean {
  const actual = Buffer.from(digest(value), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function tag(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function expired(value: string, now: number): boolean {
  return Date.parse(value) <= now;
}

function nextExecutionPhase(phase: ProjectCreationOperationPhase): ProjectCreationOperationPhase | undefined {
  switch (phase) {
    case 'reserved': return 'local-prepared';
    case 'local-prepared': return 'remote-created';
    case 'remote-created': return 'pushed';
    case 'pushed': return 'thread-started';
    case 'thread-started': return 'completed';
    default: return undefined;
  }
}

function validGithubOwner(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(value) ? value : undefined;
}

function validFailureClass(value: string): string | undefined {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function validGrantEvidence(
  value: ControlledRunnerGrantEvidence | undefined,
  expectedRoot: string,
): ControlledRunnerGrantEvidence | undefined {
  return value
    && validIdentifier(value.workspaceId)
    && validRoot(value.workspaceRoot)
    && value.workspaceRoot === expectedRoot
    && validIdentifier(value.managedThreadId)
    ? { ...value }
    : undefined;
}

function validStoredGrantEvidence(
  operation: OperationRow,
): operation is OperationRow & {
  workspace_id: string;
  workspace_root: string;
  managed_thread_id: string;
} {
  return validIdentifier(operation.workspace_id)
    && validRoot(operation.workspace_root)
    && validIdentifier(operation.managed_thread_id);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}

function validRoot(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('/home/god/Documents/Codex Workspace/')
    && value.length <= 512
    && !value.includes('\0')
    && !value.split('/').includes('..');
}

function publicControlledRunnerGrant(row: ControlledRunnerGrantRow): ControlledRunnerGrant {
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    managedThreadId: row.managed_thread_id,
    operationId: row.operation_id,
    status: 'active',
  };
}

function renderSummary(projectName: string, summary: ProjectSummary): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n');
  return `# ${projectName}\n\n## Outcome\n\n${summary.outcome}\n\n## Primary Users\n\n${summary.primaryUsers}\n\n`
    + `## Major Components\n\n${list(summary.majorComponents)}\n\n## Risks\n\n${list(summary.risks)}\n\n`
    + `## Immediate Next Steps\n\n${list(summary.immediateNextSteps)}\n`;
}

function renderTeam(team: TeamEvidence): string {
  return `# A-Team Plan\n\n\`\`\`json\n${JSON.stringify(team, null, 2)}\n\`\`\`\n`;
}
