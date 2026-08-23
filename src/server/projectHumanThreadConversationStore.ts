import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';
import {
  parseProjectHumanThreadTurn,
  turnDigest,
  type ProjectHumanThreadTurn,
} from '../shared/projectHumanThreadConversationContracts.js';

type TurnState = ProjectHumanThreadTurn['state'];
type TurnRow = { turn_json: string };
type EventRow = { event_id: string; type: string; payload_json: string; payload_digest: string; occurred_at: string };

export type ConversationStoreOptions = { databasePath?: string; now?: () => string };
export type ConversationEnqueueResult = { outcome: 'queued' | 'replayed'; turn: ProjectHumanThreadTurn };

export class ProjectHumanThreadConversationStore {
  readonly #db: DatabaseSync;
  readonly #current: (projectId: string) => ProjectHumanThreadBinding | undefined;
  readonly #now: () => string;

  constructor(current: (projectId: string) => ProjectHumanThreadBinding | undefined, options: ConversationStoreOptions = {}) {
    this.#current = current;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#db = new DatabaseSync(options.databasePath ?? process.env.ROADEX_PROJECT_HUMAN_THREAD_CONVERSATION_STATE_PATH ?? 'data/project-human-thread-conversation.sqlite');
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS project_human_thread_turn_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('queued','running','completed','failed','reconciliation-required')),
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_turns (
        turn_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','reconciliation-required')),
        turn_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS project_human_thread_one_active_turn
        ON project_human_thread_turns(project_id,generation)
        WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS project_human_thread_turn_outbox (
        turn_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        turn_json TEXT NOT NULL,
        turn_digest TEXT NOT NULL CHECK(length(turn_digest)=64),
        state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','failed','reconciliation-required')),
        attempts INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT
      );
    `);
    this.#reconcileRunning();
  }

  enqueue(actorId: string, binding: ProjectHumanThreadBinding, content: string, idempotencyKey: string, correlationId: string): ConversationEnqueueResult {
    const current = this.#current(binding.projectId);
    if (!current || current.status !== 'active' || current.generation !== binding.generation || current.conversationId !== binding.conversationId) throw new Error('Project human thread generation conflict.');
    if (!actorId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(actorId)) throw new Error('Project human thread actor is invalid.');
    requireId(idempotencyKey, 'idempotency key'); requireId(correlationId, 'correlation id');
    if (!content || content !== content.trim() || content.length > 6_000) throw new Error('Project human thread turn content is invalid.');
    return this.#transaction(() => {
      const prior = this.#db.prepare('SELECT turn_json FROM project_human_thread_turns WHERE idempotency_key=?').get(idempotencyKey) as TurnRow | undefined;
      if (prior) {
        const turn = parseProjectHumanThreadTurn(JSON.parse(prior.turn_json));
        if (turn.content !== content || turn.projectId !== binding.projectId || turn.generation !== binding.generation || turn.conversationId !== binding.conversationId) throw new Error('Project human thread turn idempotency conflict.');
        return { outcome: 'replayed' as const, turn };
      }
      const active = this.#db.prepare("SELECT turn_id FROM project_human_thread_turns WHERE project_id=? AND generation=? AND state IN ('queued','running')").get(binding.projectId, binding.generation) as { turn_id: string } | undefined;
      if (active) throw new Error('Project human thread already queued or running.');
      const occurredAt = this.#now();
      const turn = makeTurn(actorId, binding, content, idempotencyKey, correlationId, occurredAt);
      this.#insertEvent(`turn:${turn.turnId}:queued`, 'queued', { actorId, turn }, occurredAt);
      this.#insertProjection(turn);
      this.#db.prepare('INSERT INTO project_human_thread_turn_outbox(turn_id,project_id,generation,turn_json,turn_digest,state) VALUES (?,?,?,?,?,?)')
        .run(turn.turnId, turn.projectId, turn.generation, stableJson(turn), turn.turnDigest, 'pending');
      return { outcome: 'queued' as const, turn };
    });
  }

  claim(turnId: string): ProjectHumanThreadTurn {
    requireId(turnId, 'turn id');
    return this.#transaction(() => {
      const turn = this.#require(turnId);
      if (turn.state === 'running') return turn;
      if (turn.state !== 'queued') throw new Error('Project human thread turn is not queued.');
      const next = revise(turn, { state: 'running', updatedAt: this.#now() });
      this.#insertEvent(`turn:${turn.turnId}:running`, 'running', { turn: next }, next.updatedAt);
      this.#update(next);
      const result = this.#db.prepare("UPDATE project_human_thread_turn_outbox SET state='sending',attempts=attempts+1,claimed_at=? WHERE turn_id=? AND state='pending'").run(next.updatedAt, turnId);
      if (Number(result.changes) !== 1) throw new Error('Project human thread turn outbox claim changed.');
      return next;
    });
  }

  complete(turnId: string, returnedConversationId: string, assistantOutput: string): ProjectHumanThreadTurn {
    requireId(turnId, 'turn id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(returnedConversationId)) throw new Error('Project human thread returned conversation identity is invalid.');
    if (assistantOutput.length > 32_768) throw new Error('Project human thread assistant output is too large.');
    return this.#transaction(() => {
      const turn = this.#require(turnId);
      if (turn.state !== 'running') throw new Error('Project human thread turn is not running.');
      if (returnedConversationId !== turn.conversationId) throw new Error('Project human thread returned conversation identity does not match the active binding.');
      const next = revise(turn, { state: 'completed', assistantOutput, updatedAt: this.#now() });
      this.#insertEvent(`turn:${turn.turnId}:completed`, 'completed', { turn: next }, next.updatedAt);
      this.#update(next);
      this.#db.prepare("UPDATE project_human_thread_turn_outbox SET state='delivered',claimed_at=NULL,turn_json=?,turn_digest=? WHERE turn_id=?").run(stableJson(next), next.turnDigest, turnId);
      return next;
    });
  }

  fail(turnId: string, error: string, reconciliationRequired = false): ProjectHumanThreadTurn {
    requireId(turnId, 'turn id');
    if (!error || error !== error.trim() || error.length > 1_000) throw new Error('Project human thread turn failure is invalid.');
    return this.#transaction(() => {
      const turn = this.#require(turnId);
      if (!['queued', 'running'].includes(turn.state)) return turn;
      const state: TurnState = reconciliationRequired ? 'reconciliation-required' : 'failed';
      const next = revise(turn, { state, error, updatedAt: this.#now() });
      this.#insertEvent(`turn:${turn.turnId}:${state}`, state, { turn: next }, next.updatedAt);
      this.#update(next);
      this.#db.prepare('UPDATE project_human_thread_turn_outbox SET state=?,claimed_at=NULL,turn_json=?,turn_digest=? WHERE turn_id=?').run(state, stableJson(next), next.turnDigest, turnId);
      return next;
    });
  }

  get(turnId: string): ProjectHumanThreadTurn | undefined {
    const row = this.#db.prepare('SELECT turn_json FROM project_human_thread_turns WHERE turn_id=?').get(turnId) as TurnRow | undefined;
    return row ? parseProjectHumanThreadTurn(JSON.parse(row.turn_json)) : undefined;
  }
  history(projectId: string): ProjectHumanThreadTurn[] {
    const rows = this.#db.prepare('SELECT turn_json FROM project_human_thread_turns WHERE project_id=? ORDER BY rowid').all(projectId) as unknown as TurnRow[];
    return rows.map((row) => parseProjectHumanThreadTurn(JSON.parse(row.turn_json)));
  }
  pendingOutbox(projectId?: string): ProjectHumanThreadTurn[] {
    const rows = projectId
      ? this.#db.prepare("SELECT turn_json,turn_digest FROM project_human_thread_turn_outbox WHERE project_id=? AND state='pending' ORDER BY rowid").all(projectId)
      : this.#db.prepare("SELECT turn_json,turn_digest FROM project_human_thread_turn_outbox WHERE state='pending' ORDER BY rowid").all();
    return (rows as unknown as Array<{ turn_json: string; turn_digest: string }>).map((row) => {
      const turn = parseProjectHumanThreadTurn(JSON.parse(row.turn_json));
      if (turn.turnDigest !== row.turn_digest) throw new Error('Project human thread turn outbox digest is invalid.');
      return turn;
    });
  }
  rebuild(): void {
    this.#transaction(() => {
      const rows = this.#db.prepare('SELECT event_id,type,payload_json,payload_digest,occurred_at FROM project_human_thread_turn_events ORDER BY sequence').all() as unknown as EventRow[];
      this.#db.exec('DELETE FROM project_human_thread_turns; DELETE FROM project_human_thread_turn_outbox;');
      for (const row of rows) {
        if (sha256(row.payload_json) !== row.payload_digest) throw new Error('Project human thread turn event digest is invalid.');
        const payload = JSON.parse(row.payload_json) as { turn: ProjectHumanThreadTurn };
        const turn = parseProjectHumanThreadTurn(payload.turn);
        this.#upsertProjection(turn);
        if (turn.state === 'queued' || turn.state === 'running') {
          this.#db.prepare('INSERT OR REPLACE INTO project_human_thread_turn_outbox(turn_id,project_id,generation,turn_json,turn_digest,state) VALUES (?,?,?,?,?,?)').run(turn.turnId, turn.projectId, turn.generation, stableJson(turn), turn.turnDigest, turn.state === 'queued' ? 'pending' : 'sending');
        } else if (turn.state === 'completed' || turn.state === 'failed' || turn.state === 'reconciliation-required') {
          this.#db.prepare('INSERT OR REPLACE INTO project_human_thread_turn_outbox(turn_id,project_id,generation,turn_json,turn_digest,state) VALUES (?,?,?,?,?,?)').run(turn.turnId, turn.projectId, turn.generation, stableJson(turn), turn.turnDigest, turn.state === 'completed' ? 'delivered' : turn.state);
        }
      }
    });
  }
  close(): void { this.#db.close(); }

  #reconcileRunning(): void {
    this.#transaction(() => {
      const rows = this.#db.prepare("SELECT turn_json FROM project_human_thread_turns WHERE state='running'").all() as unknown as TurnRow[];
      for (const row of rows) {
        const turn = parseProjectHumanThreadTurn(JSON.parse(row.turn_json));
        const next = revise(turn, { state: 'reconciliation-required', error: 'The Roadex dispatcher restarted while this turn was running; inspect the exact Codex locator before retrying.', updatedAt: this.#now() });
        const eventId = `turn:${turn.turnId}:reconciliation-required:restart`;
        const existing = this.#db.prepare('SELECT 1 FROM project_human_thread_turn_events WHERE event_id=?').get(eventId);
        if (!existing) this.#insertEvent(eventId, 'reconciliation-required', { turn: next }, next.updatedAt);
        this.#update(next);
        this.#db.prepare("UPDATE project_human_thread_turn_outbox SET state='reconciliation-required',claimed_at=NULL,turn_json=?,turn_digest=? WHERE turn_id=?").run(stableJson(next), next.turnDigest, turn.turnId);
      }
    });
  }
  #require(turnId: string): ProjectHumanThreadTurn {
    const turn = this.get(turnId);
    if (!turn) throw new Error('Project human thread turn is missing.');
    return turn;
  }
  #insertProjection(turn: ProjectHumanThreadTurn): void {
    this.#db.prepare('INSERT INTO project_human_thread_turns(turn_id,project_id,generation,idempotency_key,state,turn_json) VALUES (?,?,?,?,?,?)').run(turn.turnId, turn.projectId, turn.generation, turn.idempotencyKey, turn.state, stableJson(turn));
  }
  #upsertProjection(turn: ProjectHumanThreadTurn): void {
    this.#db.prepare('INSERT INTO project_human_thread_turns(turn_id,project_id,generation,idempotency_key,state,turn_json) VALUES (?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET project_id=excluded.project_id,generation=excluded.generation,idempotency_key=excluded.idempotency_key,state=excluded.state,turn_json=excluded.turn_json').run(turn.turnId, turn.projectId, turn.generation, turn.idempotencyKey, turn.state, stableJson(turn));
  }
  #update(turn: ProjectHumanThreadTurn): void {
    const result = this.#db.prepare('UPDATE project_human_thread_turns SET state=?,turn_json=? WHERE turn_id=?').run(turn.state, stableJson(turn), turn.turnId);
    if (Number(result.changes) !== 1) throw new Error('Project human thread turn projection is missing.');
  }
  #insertEvent(eventId: string, type: TurnState, payload: Record<string, unknown>, occurredAt: string): void {
    const payloadJson = stableJson(payload);
    this.#db.prepare('INSERT INTO project_human_thread_turn_events(event_id,type,payload_json,payload_digest,occurred_at) VALUES (?,?,?,?,?)').run(eventId, type, payloadJson, sha256(payloadJson), occurredAt);
  }
  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ } throw error; }
  }
}

function makeTurn(actorId: string, binding: ProjectHumanThreadBinding, content: string, idempotencyKey: string, correlationId: string, occurredAt: string): ProjectHumanThreadTurn {
  const base = {
    schemaVersion: 'roadex.project-human-thread-turn.v1' as const,
    turnId: `project-human-thread-turn:${sha256(`${binding.bindingId}:${idempotencyKey}`).slice(0, 48)}`,
    actorId, projectId: binding.projectId, conversationId: binding.conversationId, generation: binding.generation,
    content, contentDigest: sha256(content), correlationId, idempotencyKey,
    state: 'queued' as const, createdAt: occurredAt, updatedAt: occurredAt,
  };
  return parseProjectHumanThreadTurn({ ...base, turnDigest: turnDigest.record(base) });
}
function revise(turn: ProjectHumanThreadTurn, changes: Partial<Pick<ProjectHumanThreadTurn, 'state' | 'assistantOutput' | 'error' | 'updatedAt'>>): ProjectHumanThreadTurn {
  const base = { ...turn, ...changes };
  delete (base as Partial<ProjectHumanThreadTurn>).turnDigest;
  return parseProjectHumanThreadTurn({ ...base, turnDigest: turnDigest.record(base) });
}
function requireId(value: string, label: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`Project human thread ${label} is invalid.`); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`; }
  return JSON.stringify(value);
}
