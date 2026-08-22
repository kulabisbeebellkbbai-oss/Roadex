import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  bindingDigest,
  parseProjectHumanThreadBinding,
  type ProjectHumanThreadBinding,
} from '../shared/projectHumanThreadContracts.js';

type EventType = 'created' | 'unavailable' | 'replacement-pending' | 'replacement-activated';
type EventRow = { type: EventType; payload_json: string; payload_digest: string };
type BindingRow = { binding_json: string };
type OutboxRow = { event_id: string; payload_json: string; payload_digest: string; state: 'pending' | 'delivered' };

export type ProjectHumanThreadOutboxRecord = {
  eventId: string;
  binding: ProjectHumanThreadBinding;
};

export type BindingWriteResult = {
  inserted: boolean;
  replay?: true;
  binding: ProjectHumanThreadBinding;
};

export class ProjectHumanThreadStore {
  readonly #db: DatabaseSync;

  constructor(path = process.env.ROADEX_PROJECT_HUMAN_THREAD_STATE_PATH ?? 'data/project-human-threads.sqlite') {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS project_human_thread_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('created','unavailable','replacement-pending','replacement-activated')),
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_bindings (
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active','unavailable','replacement-pending','retired')),
        binding_json TEXT NOT NULL,
        binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
        PRIMARY KEY(project_id,generation)
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_current (
        project_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY(project_id,generation) REFERENCES project_human_thread_bindings(project_id,generation)
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_outbox (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered')),
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  createInitial(raw: ProjectHumanThreadBinding, eventId: string): BindingWriteResult {
    const binding = parseProjectHumanThreadBinding(raw);
    if (binding.generation !== 1 || binding.predecessorGeneration !== null || binding.status !== 'active') {
      throw new Error('Initial project human thread binding is invalid.');
    }
    return this.#transaction(() => {
      const replay = this.#replay(eventId, 'created', { binding });
      if (replay) return { inserted: false, replay: true, binding: replay.binding };
      if (this.current(binding.projectId)) throw new Error('Project already has a current human thread.');
      this.#insertEvent(eventId, 'created', binding.projectId, binding.generation, binding.createdAt, { binding });
      this.#insertBinding(binding);
      this.#setCurrent(binding);
      this.#enqueue(eventId, binding);
      return { inserted: true, binding };
    });
  }

  markUnavailable(
    projectId: string,
    expectedGeneration: number,
    reason: string,
    occurredAt: string,
    eventId: string,
  ): ProjectHumanThreadBinding {
    if (!reason || reason !== reason.trim() || reason.length > 1_000) throw new Error('Unavailable reason is invalid.');
    return this.#transaction(() => {
      const replay = this.#replay(eventId, 'unavailable');
      if (replay) return replay.binding;
      const prior = this.#requireCurrent(projectId, expectedGeneration);
      if (prior.status !== 'active') throw new Error('Project human thread is not active.');
      const binding = revised(prior, { status: 'unavailable', updatedAt: occurredAt });
      this.#insertEvent(eventId, 'unavailable', projectId, expectedGeneration, occurredAt, { binding, reason });
      this.#updateBinding(binding);
      this.#enqueue(eventId, binding);
      return binding;
    });
  }

  beginReplacement(
    projectId: string,
    expectedGeneration: number,
    reason: string,
    occurredAt: string,
    eventId: string,
  ): ProjectHumanThreadBinding {
    if (!reason || reason !== reason.trim() || reason.length > 1_000) throw new Error('Replacement reason is invalid.');
    return this.#transaction(() => {
      const replay = this.#replay(eventId, 'replacement-pending');
      if (replay) return replay.binding;
      const prior = this.#requireCurrent(projectId, expectedGeneration);
      if (prior.status !== 'active' && prior.status !== 'unavailable') throw new Error('Project human thread cannot be replaced.');
      const binding = revised(prior, { status: 'replacement-pending', updatedAt: occurredAt });
      this.#insertEvent(eventId, 'replacement-pending', projectId, expectedGeneration, occurredAt, { binding, reason });
      this.#updateBinding(binding);
      this.#enqueue(eventId, binding);
      return binding;
    });
  }

  activateReplacement(
    raw: ProjectHumanThreadBinding,
    expectedGeneration: number,
    eventId: string,
  ): BindingWriteResult {
    const next = parseProjectHumanThreadBinding(raw);
    return this.#transaction(() => {
      const replay = this.#replay(eventId, 'replacement-activated');
      if (replay) return { inserted: false, replay: true, binding: replay.binding };
      const prior = this.#requireCurrent(next.projectId, expectedGeneration);
      if (prior.status !== 'replacement-pending'
        || next.status !== 'active'
        || next.generation !== expectedGeneration + 1
        || next.predecessorGeneration !== expectedGeneration
        || stableRoot(prior.root) !== stableRoot(next.root)) {
        throw new Error('Replacement project human thread binding is invalid.');
      }
      const retired = revised(prior, {
        status: 'retired', updatedAt: next.createdAt, retiredAt: next.createdAt,
      });
      this.#insertEvent(eventId, 'replacement-activated', next.projectId, next.generation, next.createdAt, { retired, binding: next });
      this.#updateBinding(retired);
      this.#insertBinding(next);
      this.#setCurrent(next);
      this.#enqueue(eventId, next);
      return { inserted: true, binding: next };
    });
  }

  current(projectId: string): ProjectHumanThreadBinding | undefined {
    const row = this.#db.prepare(`
      SELECT binding_json FROM project_human_thread_bindings
      WHERE (project_id,generation)=(SELECT project_id,generation FROM project_human_thread_current WHERE project_id=?)
    `).get(projectId) as BindingRow | undefined;
    return row ? parseProjectHumanThreadBinding(JSON.parse(row.binding_json)) : undefined;
  }

  history(projectId: string): ProjectHumanThreadBinding[] {
    const rows = this.#db.prepare(`
      SELECT binding_json FROM project_human_thread_bindings WHERE project_id=? ORDER BY generation
    `).all(projectId) as unknown as BindingRow[];
    return rows.map((row) => parseProjectHumanThreadBinding(JSON.parse(row.binding_json)));
  }

  pendingOutbox(): ProjectHumanThreadOutboxRecord[] {
    const rows = this.#db.prepare(`
      SELECT event_id,payload_json,payload_digest,state FROM project_human_thread_outbox
      WHERE state='pending' ORDER BY rowid
    `).all() as unknown as OutboxRow[];
    return rows.map((row) => {
      if (sha256(row.payload_json) !== row.payload_digest) throw new Error('Project human thread outbox digest is invalid.');
      return { eventId: row.event_id, binding: parseProjectHumanThreadBinding(JSON.parse(row.payload_json)) };
    });
  }

  markOutboxDelivered(eventId: string): void {
    const result = this.#db.prepare("UPDATE project_human_thread_outbox SET state='delivered' WHERE event_id=? AND state='pending'")
      .run(eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.#db.prepare('SELECT state FROM project_human_thread_outbox WHERE event_id=?').get(eventId) as { state: string } | undefined;
    if (existing?.state === 'delivered') return;
    throw new Error('Project human thread outbox record is missing.');
  }

  rebuild(): void {
    this.#transaction(() => {
      const rows = this.#db.prepare(`
        SELECT type,payload_json,payload_digest FROM project_human_thread_events ORDER BY sequence
      `).all() as unknown as EventRow[];
      this.#db.exec('DELETE FROM project_human_thread_current; DELETE FROM project_human_thread_bindings;');
      for (const row of rows) {
        if (sha256(row.payload_json) !== row.payload_digest) throw new Error('Project human thread event digest is invalid.');
        const payload = JSON.parse(row.payload_json) as { binding: ProjectHumanThreadBinding; retired?: ProjectHumanThreadBinding };
        if (row.type === 'created') {
          const binding = parseProjectHumanThreadBinding(payload.binding);
          this.#insertBinding(binding); this.#setCurrent(binding);
        } else if (row.type === 'unavailable' || row.type === 'replacement-pending') {
          this.#updateBinding(parseProjectHumanThreadBinding(payload.binding));
        } else {
          this.#updateBinding(parseProjectHumanThreadBinding(payload.retired));
          const binding = parseProjectHumanThreadBinding(payload.binding);
          this.#insertBinding(binding); this.#setCurrent(binding);
        }
      }
    });
  }

  close(): void { this.#db.close(); }

  #requireCurrent(projectId: string, generation: number): ProjectHumanThreadBinding {
    const binding = this.current(projectId);
    if (!binding || binding.generation !== generation) throw new Error('Project human thread generation conflict.');
    return binding;
  }

  #replay(eventId: string, type: EventType, expected?: Record<string, unknown>): { binding: ProjectHumanThreadBinding } | undefined {
    const row = this.#db.prepare('SELECT type,payload_json,payload_digest FROM project_human_thread_events WHERE event_id=?').get(eventId) as EventRow | undefined;
    if (!row) return undefined;
    if (row.type !== type || sha256(row.payload_json) !== row.payload_digest) throw new Error('Project human thread event conflict.');
    if (expected && stableJson(expected) !== row.payload_json) throw new Error('Project human thread event conflict.');
    const payload = JSON.parse(row.payload_json) as { binding: ProjectHumanThreadBinding };
    return { binding: parseProjectHumanThreadBinding(payload.binding) };
  }

  #insertEvent(eventId: string, type: EventType, projectId: string, generation: number, occurredAt: string, payload: Record<string, unknown>): void {
    const payloadJson = stableJson(payload);
    this.#db.prepare(`INSERT INTO project_human_thread_events(event_id,type,project_id,generation,payload_json,payload_digest,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .run(eventId, type, projectId, generation, payloadJson, sha256(payloadJson), occurredAt);
  }

  #insertBinding(binding: ProjectHumanThreadBinding): void {
    this.#db.prepare(`INSERT INTO project_human_thread_bindings(project_id,generation,conversation_id,status,binding_json,binding_digest) VALUES (?,?,?,?,?,?)`)
      .run(binding.projectId, binding.generation, binding.conversationId, binding.status, stableJson(binding), binding.recordDigest);
  }

  #updateBinding(binding: ProjectHumanThreadBinding): void {
    const result = this.#db.prepare(`UPDATE project_human_thread_bindings SET status=?,binding_json=?,binding_digest=? WHERE project_id=? AND generation=?`)
      .run(binding.status, stableJson(binding), binding.recordDigest, binding.projectId, binding.generation);
    if (Number(result.changes) !== 1) throw new Error('Project human thread projection is missing.');
  }

  #setCurrent(binding: ProjectHumanThreadBinding): void {
    this.#db.prepare(`INSERT INTO project_human_thread_current(project_id,generation,conversation_id) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET generation=excluded.generation,conversation_id=excluded.conversation_id`)
      .run(binding.projectId, binding.generation, binding.conversationId);
  }

  #enqueue(eventId: string, binding: ProjectHumanThreadBinding): void {
    const payloadJson = stableJson(binding);
    this.#db.prepare(`INSERT INTO project_human_thread_outbox(event_id,project_id,generation,payload_json,payload_digest) VALUES (?,?,?,?,?)`)
      .run(eventId, binding.projectId, binding.generation, payloadJson, sha256(payloadJson));
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ } throw error; }
  }
}

function revised(
  prior: ProjectHumanThreadBinding,
  changes: Partial<Pick<ProjectHumanThreadBinding, 'status' | 'updatedAt' | 'retiredAt'>>,
): ProjectHumanThreadBinding {
  const withoutDigest = { ...prior, ...changes };
  delete (withoutDigest as Partial<ProjectHumanThreadBinding>).recordDigest;
  return parseProjectHumanThreadBinding({ ...withoutDigest, recordDigest: bindingDigest(withoutDigest) });
}

function stableRoot(value: ProjectHumanThreadBinding['root']): string { return stableJson(value); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
