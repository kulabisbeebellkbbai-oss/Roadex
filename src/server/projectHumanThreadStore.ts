import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  bindingDigest,
  parseProjectHumanThreadBinding,
  type ProjectHumanThreadBinding,
} from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadCandidate } from './projectHumanThreadAuthority.js';

type EventType = 'created' | 'unavailable' | 'recovered' | 'replacement-pending' | 'replacement-activated';
type EventRow = { type: EventType; payload_json: string; payload_digest: string };
type BindingRow = { binding_json: string };
type OutboxRow = { event_id: string; payload_json: string; payload_digest: string; state: 'pending' | 'delivered' };

export type ProjectRootIdentity = {
  canonicalPath: string;
  dev: string;
  ino: string;
};

export type ProjectHumanThreadOutboxRecord = {
  eventId: string;
  binding: ProjectHumanThreadBinding;
};

export type BindingWriteResult = {
  inserted: boolean;
  replay?: true;
  binding: ProjectHumanThreadBinding;
};
export type ReplacementIntent = {
  state: 'prepared' | 'completed';
  eventId: string;
  idempotencyKey: string;
  expectedGeneration: number;
  projectRoot: string;
  provenanceDigest: string;
  reason: string;
  conversationId: string | null;
  createPhase: 'not-started' | 'creating' | 'reconcile-required' | 'created';
  createdCandidate?: ProjectHumanThreadCandidate;
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
        type TEXT NOT NULL CHECK(type IN ('created','unavailable','recovered','replacement-pending','replacement-activated')),
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
        root_canonical_path TEXT NOT NULL,
        root_dev TEXT NOT NULL,
        root_ino TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS project_human_thread_creation_intents (
        project_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        state TEXT NOT NULL CHECK(state IN ('prepared','completed')),
        conversation_id TEXT,
        create_phase TEXT NOT NULL DEFAULT 'not-started' CHECK(create_phase IN ('not-started','creating','reconcile-required','created')),
        created_candidate_json TEXT,
        root_canonical_path TEXT,
        root_dev TEXT,
        root_ino TEXT
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_replacement_intents (
        project_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        state TEXT NOT NULL CHECK(state IN ('prepared','completed')),
        conversation_id TEXT,
        create_phase TEXT NOT NULL DEFAULT 'not-started' CHECK(create_phase IN ('not-started','creating','reconcile-required','created')),
        created_candidate_json TEXT,
        root_canonical_path TEXT,
        root_dev TEXT,
        root_ino TEXT
      );
    `);
    this.#migrateCreateIntentColumns();
    this.#migrateRecoveredEvent();
    this.#migrateRootIdentity();
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
      if (this.currentByRoot(binding.root)) throw new Error('Project root already has a current human thread.');
      this.#insertEvent(eventId, 'created', binding.projectId, binding.generation, binding.createdAt, { binding });
      this.#insertBinding(binding);
      this.#setCurrent(binding);
      this.#enqueue(eventId, binding);
      return { inserted: true, binding };
    });
  }

  beginCreationIntent(
    projectId: string,
    eventId: string,
    request: { projectRoot: string; provenanceDigest: string },
    root?: ProjectRootIdentity,
  ): { inserted: boolean } {
    const requestJson = stableJson(request);
    return this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT event_id,request_json,request_digest FROM project_human_thread_creation_intents WHERE project_id=?
      `).get(projectId) as { event_id: string; request_json: string; request_digest: string } | undefined;
      if (existing) {
        if (existing.event_id !== eventId || existing.request_json !== requestJson
          || existing.request_digest !== sha256(requestJson)) throw new Error('Project human thread creation intent conflict.');
        return { inserted: false };
      }
      if (this.current(projectId)) throw new Error('Project already has a current human thread.');
      if (!root) throw new Error('Project root identity is required.');
      if (this.currentByRoot(root)) throw new Error('Project root already has a current human thread.');
      const rootIntent = this.#creationIntentByRoot(root);
      if (rootIntent) {
        if (rootIntent.event_id !== eventId || rootIntent.request_json !== requestJson
          || rootIntent.request_digest !== sha256(requestJson)) {
          throw new Error('Project human thread root creation intent conflict.');
        }
        return { inserted: false };
      }
      this.#db.prepare(`INSERT INTO project_human_thread_creation_intents(
        project_id,event_id,request_json,request_digest,state,conversation_id,root_canonical_path,root_dev,root_ino
      ) VALUES (?,?,?,?,'prepared',NULL,?,?,?)`).run(
        projectId, eventId, requestJson, sha256(requestJson), root.canonicalPath, root.dev, root.ino,
      );
      return { inserted: true };
    });
  }

  completeCreationIntent(projectId: string, eventId: string, conversationId: string): void {
    const result = this.#db.prepare(`
      UPDATE project_human_thread_creation_intents SET state='completed',conversation_id=?
      WHERE project_id=? AND event_id=? AND state='prepared'
    `).run(conversationId, projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.#db.prepare(`
      SELECT state,conversation_id FROM project_human_thread_creation_intents WHERE project_id=? AND event_id=?
    `).get(projectId, eventId) as { state: string; conversation_id: string | null } | undefined;
    if (existing?.state === 'completed' && existing.conversation_id === conversationId) return;
    throw new Error('Project human thread creation intent is missing.');
  }

  creationIntent(projectId: string): {
    state: 'prepared' | 'completed'; eventId: string; conversationId: string | null;
    createPhase: 'not-started' | 'creating' | 'reconcile-required' | 'created';
    createdCandidate?: ProjectHumanThreadCandidate;
  } | undefined {
    const row = this.#db.prepare(`
      SELECT state,event_id,conversation_id,create_phase,created_candidate_json
      FROM project_human_thread_creation_intents WHERE project_id=?
    `).get(projectId) as {
      state: 'prepared' | 'completed'; event_id: string; conversation_id: string | null;
      create_phase: 'not-started' | 'creating' | 'reconcile-required' | 'created'; created_candidate_json: string | null;
    } | undefined;
    return row ? {
      state: row.state, eventId: row.event_id, conversationId: row.conversation_id,
      createPhase: row.create_phase,
      ...(row.created_candidate_json ? { createdCandidate: JSON.parse(row.created_candidate_json) as ProjectHumanThreadCandidate } : {}),
    } : undefined;
  }

  markCreationStarted(projectId: string, eventId: string): void {
    const result = this.#db.prepare(`UPDATE project_human_thread_creation_intents SET create_phase='creating'
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase='not-started'`).run(projectId, eventId);
    if (Number(result.changes) === 1 || this.creationIntent(projectId)?.createPhase === 'creating') return;
    throw new Error('Project human thread creation phase conflict.');
  }

  markCreationNoSideEffect(projectId: string, eventId: string): void {
    const result = this.#db.prepare(`UPDATE project_human_thread_creation_intents
      SET create_phase='not-started',created_candidate_json=NULL
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase='creating'`).run(projectId, eventId);
    if (Number(result.changes) === 1 || this.creationIntent(projectId)?.createPhase === 'not-started') return;
    throw new Error('Project human thread creation phase conflict.');
  }

  markCreationReconciliationRequired(projectId: string, eventId: string): void {
    const result = this.#db.prepare(`UPDATE project_human_thread_creation_intents SET create_phase='reconcile-required'
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase IN ('creating','reconcile-required')`).run(projectId, eventId);
    if (Number(result.changes) === 1 || this.creationIntent(projectId)?.createPhase === 'reconcile-required') return;
    throw new Error('Project human thread creation phase conflict.');
  }

  markCreationCreated(projectId: string, eventId: string, candidate: ProjectHumanThreadCandidate): void {
    const candidateJson = stableJson(candidate);
    const result = this.#db.prepare(`UPDATE project_human_thread_creation_intents
      SET create_phase='created',created_candidate_json=?
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase IN ('creating','created')`).run(candidateJson, projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.creationIntent(projectId);
    if (existing?.eventId === eventId && existing.createPhase === 'created'
      && existing.createdCandidate && stableJson(existing.createdCandidate) === candidateJson) return;
    throw new Error('Project human thread creation phase conflict.');
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

  markRecovered(
    projectId: string,
    expectedGeneration: number,
    occurredAt: string,
    eventId: string,
  ): ProjectHumanThreadBinding {
    return this.#transaction(() => {
      const replay = this.#replay(eventId, 'recovered');
      if (replay) return replay.binding;
      const prior = this.#requireCurrent(projectId, expectedGeneration);
      if (prior.status !== 'unavailable') throw new Error('Project human thread is not unavailable.');
      const binding = revised(prior, { status: 'active', updatedAt: laterTimestamp(occurredAt, prior.updatedAt) });
      this.#insertEvent(eventId, 'recovered', projectId, expectedGeneration, occurredAt, { binding });
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
    intent?: Omit<ReplacementIntent, 'state' | 'eventId' | 'conversationId' | 'createPhase' | 'createdCandidate'>,
    root?: ProjectRootIdentity,
  ): ProjectHumanThreadBinding {
    if (!reason || reason !== reason.trim() || reason.length > 1_000) throw new Error('Replacement reason is invalid.');
    return this.#transaction(() => {
      const replay = this.#replay(eventId, 'replacement-pending');
      if (replay) {
        if (intent) this.#assertReplacementIntent(projectId, eventId, intent);
        return replay.binding;
      }
      const prior = this.#requireCurrent(projectId, expectedGeneration);
      if (prior.status !== 'active' && prior.status !== 'unavailable') throw new Error('Project human thread cannot be replaced.');
      if (intent) {
        const identity = root ?? prior.root;
        if (stableRoot(identity) !== stableRoot(prior.root)) throw new Error('Project human thread replacement root conflict.');
        const request = {
          idempotencyKey: intent.idempotencyKey,
          expectedGeneration: intent.expectedGeneration,
          projectRoot: intent.projectRoot,
          provenanceDigest: intent.provenanceDigest,
          reason: intent.reason,
        };
        const requestJson = stableJson(request);
        const existingIntent = this.#db.prepare(`
          SELECT event_id,request_json,state FROM project_human_thread_replacement_intents WHERE project_id=?
        `).get(projectId) as { event_id: string; request_json: string; state: 'prepared' | 'completed' } | undefined;
        const rootIntent = this.#replacementIntentByRoot(identity);
        if (rootIntent && rootIntent.project_id !== projectId) {
          throw new Error('Project human thread root replacement intent conflict.');
        }
        if (existingIntent?.state === 'prepared') {
          throw new Error('Project human thread replacement intent conflict.');
        }
        // Keep the durable record for the in-flight operation, while allowing
        // a later generation to start a distinct replacement after the prior
        // intent has completed.
        if (existingIntent?.state === 'completed') {
          this.#db.prepare('DELETE FROM project_human_thread_replacement_intents WHERE project_id=?').run(projectId);
        }
        this.#db.prepare(`INSERT INTO project_human_thread_replacement_intents(
          project_id,event_id,request_json,request_digest,state,conversation_id,create_phase,created_candidate_json,root_canonical_path,root_dev,root_ino
        ) VALUES (?,?,?,?, 'prepared',NULL,'not-started',NULL,?,?,?)`).run(
          projectId, eventId, requestJson, sha256(requestJson), identity.canonicalPath, identity.dev, identity.ino,
        );
      }
      const binding = revised(prior, { status: 'replacement-pending', updatedAt: occurredAt });
      this.#insertEvent(eventId, 'replacement-pending', projectId, expectedGeneration, occurredAt, { binding, reason });
      this.#updateBinding(binding);
      this.#enqueue(eventId, binding);
      return binding;
    });
  }

  replacementIntent(projectId: string): ReplacementIntent | undefined {
    const row = this.#db.prepare(`
      SELECT event_id,request_json,state,conversation_id,create_phase,created_candidate_json
      FROM project_human_thread_replacement_intents WHERE project_id=?
    `).get(projectId) as {
      event_id: string;
      request_json: string;
      state: 'prepared' | 'completed';
      conversation_id: string | null;
      create_phase: ReplacementIntent['createPhase'];
      created_candidate_json: string | null;
    } | undefined;
    if (!row) return undefined;
    const request = JSON.parse(row.request_json) as Omit<ReplacementIntent, 'state' | 'eventId' | 'conversationId'>;
    return {
      ...request,
      state: row.state,
      eventId: row.event_id,
      conversationId: row.conversation_id,
      createPhase: row.create_phase,
      ...(row.created_candidate_json ? { createdCandidate: JSON.parse(row.created_candidate_json) as ProjectHumanThreadCandidate } : {}),
    };
  }

  markReplacementCreateStarted(projectId: string, eventId: string): void {
    const result = this.#db.prepare(`
      UPDATE project_human_thread_replacement_intents SET create_phase='creating'
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase='not-started'
    `).run(projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.replacementIntent(projectId);
    if (existing?.eventId !== eventId || existing.state !== 'prepared') throw new Error('Project human thread replacement intent is missing.');
    if (existing.createPhase === 'creating') return;
    throw new Error('Project human thread replacement create phase conflict.');
  }

  markReplacementCreateNoSideEffect(projectId: string, eventId: string): void {
    const result = this.#db.prepare(`
      UPDATE project_human_thread_replacement_intents SET create_phase='not-started',created_candidate_json=NULL
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase='creating'
    `).run(projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.replacementIntent(projectId);
    if (existing?.eventId === eventId && existing.createPhase === 'not-started') return;
    throw new Error('Project human thread replacement create phase conflict.');
  }

  markReplacementCreateReconciliationRequired(projectId: string, eventId: string): void {
    const result = this.#db.prepare(`
      UPDATE project_human_thread_replacement_intents SET create_phase='reconcile-required'
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase IN ('creating','reconcile-required')
    `).run(projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.replacementIntent(projectId);
    if (existing?.eventId === eventId && existing.createPhase === 'reconcile-required') return;
    throw new Error('Project human thread replacement create phase conflict.');
  }

  markReplacementCreated(projectId: string, eventId: string, candidate: ProjectHumanThreadCandidate): void {
    const candidateJson = stableJson(candidate);
    const result = this.#db.prepare(`
      UPDATE project_human_thread_replacement_intents
      SET create_phase='created',created_candidate_json=?
      WHERE project_id=? AND event_id=? AND state='prepared' AND create_phase IN ('creating','created')
    `).run(candidateJson, projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.replacementIntent(projectId);
    if (existing?.eventId === eventId && existing.createPhase === 'created'
      && existing.createdCandidate && stableJson(existing.createdCandidate) === candidateJson) return;
    throw new Error('Project human thread replacement create phase conflict.');
  }

  completeReplacementIntent(projectId: string, eventId: string, conversationId: string): void {
    const result = this.#db.prepare(`
      UPDATE project_human_thread_replacement_intents SET state='completed',conversation_id=?
      WHERE project_id=? AND event_id=? AND state='prepared'
    `).run(conversationId, projectId, eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.replacementIntent(projectId);
    if (existing?.state === 'completed' && existing.eventId === eventId && existing.conversationId === conversationId) return;
    throw new Error('Project human thread replacement intent is missing.');
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

  currentByRoot(root: ProjectRootIdentity): ProjectHumanThreadBinding | undefined {
    const row = this.#db.prepare(`
      SELECT binding.binding_json FROM project_human_thread_current current
      JOIN project_human_thread_bindings binding
        ON binding.project_id=current.project_id AND binding.generation=current.generation
      WHERE current.root_canonical_path=? AND current.root_dev=? AND current.root_ino=?
    `).get(root.canonicalPath, root.dev, root.ino) as BindingRow | undefined;
    return row ? parseProjectHumanThreadBinding(JSON.parse(row.binding_json)) : undefined;
  }

  history(projectId: string): ProjectHumanThreadBinding[] {
    const rows = this.#db.prepare(`
      SELECT binding_json FROM project_human_thread_bindings WHERE project_id=? ORDER BY generation
    `).all(projectId) as unknown as BindingRow[];
    return rows.map((row) => parseProjectHumanThreadBinding(JSON.parse(row.binding_json)));
  }

  isBoundConversation(conversationId: string): boolean {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conversationId)) return false;
    const row = this.#db.prepare(`
      SELECT 1 AS present FROM project_human_thread_bindings
      WHERE conversation_id=? LIMIT 1
    `).get(conversationId) as { present: number } | undefined;
    return row?.present === 1;
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
        } else if (row.type === 'unavailable' || row.type === 'recovered' || row.type === 'replacement-pending') {
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

  #migrateRecoveredEvent(): void {
    const row = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_human_thread_events'")
      .get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'recovered'")) return;
    this.#transaction(() => {
      this.#db.exec(`
        ALTER TABLE project_human_thread_events RENAME TO project_human_thread_events_v1;
        CREATE TABLE project_human_thread_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK(type IN ('created','unavailable','recovered','replacement-pending','replacement-activated')),
          project_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
          occurred_at TEXT NOT NULL
        );
        INSERT INTO project_human_thread_events SELECT * FROM project_human_thread_events_v1;
        DROP TABLE project_human_thread_events_v1;
      `);
    });
  }

  #migrateCreateIntentColumns(): void {
    const migrate = (table: 'project_human_thread_creation_intents' | 'project_human_thread_replacement_intents'): void => {
      const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'create_phase')) {
        this.#db.exec(`ALTER TABLE ${table} ADD COLUMN create_phase TEXT NOT NULL DEFAULT 'not-started'`);
      }
      if (!columns.some((column) => column.name === 'created_candidate_json')) {
        this.#db.exec(`ALTER TABLE ${table} ADD COLUMN created_candidate_json TEXT`);
      }
    };
    const creationColumns = this.#db.prepare('PRAGMA table_info(project_human_thread_creation_intents)')
      .all() as unknown as Array<{ name: string }>;
    const creationHadCreatePhase = creationColumns.some((column) => column.name === 'create_phase');
    migrate('project_human_thread_creation_intents');
    if (!creationHadCreatePhase) {
      // A prepared legacy intent may already have crossed the external create
      // boundary. Never reinterpret its new default as permission to create.
      this.#db.exec(`
        UPDATE project_human_thread_creation_intents SET create_phase='reconcile-required'
        WHERE state='prepared'
      `);
    }

    const replacementColumns = this.#db.prepare('PRAGMA table_info(project_human_thread_replacement_intents)')
      .all() as unknown as Array<{ name: string }>;
    const replacementHadCreatePhase = replacementColumns.some((column) => column.name === 'create_phase');
    migrate('project_human_thread_replacement_intents');
    if (!replacementHadCreatePhase) {
      // Older replacement intents had no durable create phase. If their
      // binding is still pending, the external create effect is unknowable;
      // classify it as reconciliation-required rather than allowing a blind
      // retry after restart.
      this.#db.exec(`
        UPDATE project_human_thread_replacement_intents SET create_phase='reconcile-required'
        WHERE project_id IN (
          SELECT current.project_id FROM project_human_thread_current current
          JOIN project_human_thread_bindings binding
            ON binding.project_id=current.project_id AND binding.generation=current.generation
          WHERE binding.status='replacement-pending'
        )
      `);
    }
  }

  #migrateRootIdentity(): void {
    const addColumns = (table: string, columns: string[]): void => {
      const existing = this.#db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
      for (const column of columns) {
        if (!existing.some((item) => item.name === column)) {
          this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        }
      }
    };
    // Databases created before root identity was authoritative have a
    // project-only current projection. Backfill it from the immutable binding
    // record before publishing the unique root index.
    addColumns('project_human_thread_current', ['root_canonical_path', 'root_dev', 'root_ino']);
    addColumns('project_human_thread_creation_intents', ['root_canonical_path', 'root_dev', 'root_ino']);
    addColumns('project_human_thread_replacement_intents', ['root_canonical_path', 'root_dev', 'root_ino']);
    this.#transaction(() => {
      const rows = this.#db.prepare(`
        SELECT current.project_id,current.generation,current.root_canonical_path,current.root_dev,current.root_ino,
               binding.binding_json
        FROM project_human_thread_current current
        JOIN project_human_thread_bindings binding
          ON binding.project_id=current.project_id AND binding.generation=current.generation
      `).all() as unknown as Array<{
        project_id: string; generation: number; root_canonical_path: string | null; root_dev: string | null;
        root_ino: string | null; binding_json: string;
      }>;
      for (const row of rows) {
        const binding = parseProjectHumanThreadBinding(JSON.parse(row.binding_json));
        if ((row.root_canonical_path !== null || row.root_dev !== null || row.root_ino !== null)
          && (row.root_canonical_path !== binding.root.canonicalPath || row.root_dev !== binding.root.dev || row.root_ino !== binding.root.ino)) {
          throw new Error('Project human thread root identity projection conflicts with its binding.');
        }
        this.#db.prepare(`UPDATE project_human_thread_current SET root_canonical_path=?,root_dev=?,root_ino=? WHERE project_id=?`)
          .run(binding.root.canonicalPath, binding.root.dev, binding.root.ino, row.project_id);
      }
      const currentRoots = this.#db.prepare(`
        SELECT root_dev,root_ino,COUNT(*) AS count FROM project_human_thread_current
        WHERE root_dev IS NOT NULL AND root_ino IS NOT NULL GROUP BY root_dev,root_ino HAVING COUNT(*)>1
      `).all() as unknown as Array<{ root_dev: string; root_ino: string; count: number }>;
      if (currentRoots.length > 0) throw new Error('Project human thread root identity conflict detected during migration.');
      const intents = this.#db.prepare(`
        SELECT current.project_id,current.root_canonical_path,current.root_dev,current.root_ino
        FROM project_human_thread_current current
      `).all() as unknown as Array<{ project_id: string; root_canonical_path: string; root_dev: string; root_ino: string }>;
      for (const row of intents) {
        this.#db.prepare(`UPDATE project_human_thread_creation_intents
          SET root_canonical_path=?,root_dev=?,root_ino=?
          WHERE project_id=? AND (root_dev IS NULL OR root_ino IS NULL)`).run(
          row.root_canonical_path, row.root_dev, row.root_ino, row.project_id,
        );
        this.#db.prepare(`UPDATE project_human_thread_replacement_intents
          SET root_canonical_path=?,root_dev=?,root_ino=?
          WHERE project_id=? AND (root_dev IS NULL OR root_ino IS NULL)`).run(
          row.root_canonical_path, row.root_dev, row.root_ino, row.project_id,
        );
      }
      const unresolvedIntents = this.#db.prepare(`
        SELECT project_id FROM project_human_thread_creation_intents
        WHERE root_canonical_path IS NULL OR root_dev IS NULL OR root_ino IS NULL
        UNION ALL
        SELECT project_id FROM project_human_thread_replacement_intents
        WHERE root_canonical_path IS NULL OR root_dev IS NULL OR root_ino IS NULL
      `).all() as unknown as Array<{ project_id: string }>;
      if (unresolvedIntents.length > 0) {
        throw new Error('Project human thread root identity migration is unresolved.');
      }
      this.#db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS project_human_thread_current_root_unique
          ON project_human_thread_current(root_dev,root_ino)
          WHERE root_dev IS NOT NULL AND root_ino IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS project_human_thread_creation_root_pending_unique
          ON project_human_thread_creation_intents(root_dev,root_ino)
          WHERE state='prepared' AND root_dev IS NOT NULL AND root_ino IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS project_human_thread_replacement_root_pending_unique
          ON project_human_thread_replacement_intents(root_dev,root_ino)
          WHERE state='prepared' AND root_dev IS NOT NULL AND root_ino IS NOT NULL;
      `);
    });
  }

  #creationIntentByRoot(root: ProjectRootIdentity): { event_id: string; request_json: string; request_digest: string } | undefined {
    return this.#db.prepare(`SELECT event_id,request_json,request_digest
      FROM project_human_thread_creation_intents WHERE root_canonical_path=? AND root_dev=? AND root_ino=?`)
      .get(root.canonicalPath, root.dev, root.ino) as { event_id: string; request_json: string; request_digest: string } | undefined;
  }

  #replacementIntentByRoot(root: ProjectRootIdentity): { project_id: string } | undefined {
    return this.#db.prepare(`SELECT project_id FROM project_human_thread_replacement_intents
      WHERE root_canonical_path=? AND root_dev=? AND root_ino=? AND state='prepared'`)
      .get(root.canonicalPath, root.dev, root.ino) as { project_id: string } | undefined;
  }

  #requireCurrent(projectId: string, generation: number): ProjectHumanThreadBinding {
    const binding = this.current(projectId);
    if (!binding || binding.generation !== generation) throw new Error('Project human thread generation conflict.');
    return binding;
  }

  #assertReplacementIntent(projectId: string, eventId: string, intent: Omit<ReplacementIntent, 'state' | 'eventId' | 'conversationId' | 'createPhase' | 'createdCandidate'>): void {
    const existing = this.replacementIntent(projectId);
    const request = {
      idempotencyKey: intent.idempotencyKey,
      expectedGeneration: intent.expectedGeneration,
      projectRoot: intent.projectRoot,
      provenanceDigest: intent.provenanceDigest,
      reason: intent.reason,
    };
    if (!existing || existing.eventId !== eventId || stableJson(request) !== stableJson({
      idempotencyKey: existing.idempotencyKey,
      expectedGeneration: existing.expectedGeneration,
      projectRoot: existing.projectRoot,
      provenanceDigest: existing.provenanceDigest,
      reason: existing.reason,
    })) throw new Error('Project human thread replacement intent conflict.');
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
    this.#db.prepare(`INSERT INTO project_human_thread_current(
      project_id,generation,conversation_id,root_canonical_path,root_dev,root_ino
    ) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
      generation=excluded.generation,conversation_id=excluded.conversation_id,
      root_canonical_path=excluded.root_canonical_path,root_dev=excluded.root_dev,root_ino=excluded.root_ino`)
      .run(binding.projectId, binding.generation, binding.conversationId,
        binding.root.canonicalPath, binding.root.dev, binding.root.ino);
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
function laterTimestamp(candidate: string, prior: string): string {
  const candidateTime = Date.parse(candidate);
  const priorTime = Date.parse(prior);
  if (Number.isNaN(candidateTime) || Number.isNaN(priorTime)) throw new Error('Project human thread timestamp is invalid.');
  return new Date(Math.max(candidateTime, priorTime + 1)).toISOString();
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
