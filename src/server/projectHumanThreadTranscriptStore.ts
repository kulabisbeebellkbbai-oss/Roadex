import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  messageDigest,
  parseProjectHumanThreadMessage,
  parseProjectHumanThreadResponse,
  responseDigest,
  type ProjectHumanThreadMessage,
  type ProjectHumanThreadResponse,
} from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';

type TranscriptEventType = 'question-received' | 'response-submitted';
type EventRow = { event_id: string; type: TranscriptEventType; payload_json: string; payload_digest: string; occurred_at: string };
type ResponseRow = { response_id: string; message_id: string; response_digest: string; response_json: string; state: 'pending' | 'delivered' };
type NonceRow = { nonce: string; message_id: string; message_digest: string; request_timestamp: string };
type ReceiptRow = { request_nonce: string; receipt_nonce: string; receipt_body: string; occurred_at: string; message_digest: string };
type OutboxRow = { event_id: string; response_json: string; response_digest: string; state: 'pending' | 'delivered' };

export type ProjectHumanThreadQuestionState = 'pending' | 'answered';
export type ProjectHumanThreadQuestionRecord = {
  message: ProjectHumanThreadMessage;
  state: ProjectHumanThreadQuestionState;
  response?: ProjectHumanThreadResponse;
};
export type ProjectHumanThreadResponseOutboxRecord = {
  eventId: string;
  response: ProjectHumanThreadResponse;
};
export type ReceiveQuestionResult = {
  outcome: 'received' | 'replayed';
  question: ProjectHumanThreadQuestionRecord;
};
export type SubmitResponseResult = {
  outcome: 'submitted' | 'replayed';
  response: ProjectHumanThreadResponse;
};
type CurrentBinding = (projectId: string) => ProjectHumanThreadBinding | undefined;

export class ProjectHumanThreadTranscriptStore {
  readonly #db: DatabaseSync;
  readonly #current: CurrentBinding;
  readonly #now: () => string;
  readonly #maxClockSkewMs: number;

  constructor(
    current: CurrentBinding,
    options: { databasePath?: string; now?: () => string; maxClockSkewMs?: number } = {},
  ) {
    this.#current = current;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxClockSkewMs = options.maxClockSkewMs ?? 300_000;
    this.#db = new DatabaseSync(options.databasePath ?? process.env.ROADEX_PROJECT_HUMAN_THREAD_TRANSCRIPT_STATE_PATH ?? 'data/project-human-thread-transcript.sqlite');
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS project_human_thread_transcript_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('question-received','response-submitted')),
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_transcript_questions (
        message_id TEXT PRIMARY KEY,
        message_digest TEXT NOT NULL CHECK(length(message_digest)=64),
        project_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','answered')),
        message_json TEXT NOT NULL,
        response_id TEXT
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_transcript_responses (
        response_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        response_digest TEXT NOT NULL CHECK(length(response_digest)=64),
        response_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered'))
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_transcript_nonces (
        nonce TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        message_digest TEXT NOT NULL CHECK(length(message_digest)=64),
        request_timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_transcript_receipts (
        request_nonce TEXT PRIMARY KEY,
        receipt_nonce TEXT NOT NULL UNIQUE,
        receipt_body TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        message_digest TEXT NOT NULL CHECK(length(message_digest)=64)
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_transcript_outbox (
        event_id TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        response_digest TEXT NOT NULL CHECK(length(response_digest)=64),
        state TEXT NOT NULL CHECK(state IN ('pending','delivered'))
      );
    `);
  }

  receiveQuestion(message: ProjectHumanThreadMessage, requestNonce: string, requestTimestamp: string, eventId = `question:${sha256(message.messageId).slice(0, 48)}`): ReceiveQuestionResult {
    const parsed = parseProjectHumanThreadMessage(message);
    requireId(requestNonce, 'question nonce');
    requireTimestamp(requestTimestamp);
    return this.#transaction(() => {
      const nonce = this.#db.prepare('SELECT nonce,message_id,message_digest,request_timestamp FROM project_human_thread_transcript_nonces WHERE nonce=?').get(requestNonce) as NonceRow | undefined;
      if (nonce) {
        if (nonce.message_id !== parsed.messageId || nonce.message_digest !== parsed.messageDigest) throw new Error('Project human thread question nonce conflict.');
        return { outcome: 'replayed' as const, question: this.#requireQuestion(parsed.messageId) };
      }
      this.#assertTimestampFresh(requestTimestamp);
      this.#assertCurrent(parsed);
      const existing = this.#db.prepare('SELECT message_id,message_digest FROM project_human_thread_transcript_questions WHERE message_id=?').get(parsed.messageId) as { message_id: string; message_digest: string } | undefined;
      if (existing) {
        if (existing.message_digest !== parsed.messageDigest) throw new Error('Project human thread question conflict.');
        this.#db.prepare('INSERT INTO project_human_thread_transcript_nonces(nonce,message_id,message_digest,request_timestamp) VALUES (?,?,?,?)')
          .run(requestNonce, parsed.messageId, parsed.messageDigest, requestTimestamp);
        return { outcome: 'replayed' as const, question: this.#requireQuestion(parsed.messageId) };
      }
      const payload = { message: parsed, nonce: requestNonce, requestTimestamp };
      this.#insertEvent(eventId, 'question-received', payload, parsed.occurredAt);
      this.#db.prepare('INSERT INTO project_human_thread_transcript_nonces(nonce,message_id,message_digest,request_timestamp) VALUES (?,?,?,?)')
        .run(requestNonce, parsed.messageId, parsed.messageDigest, requestTimestamp);
      this.#db.prepare('INSERT INTO project_human_thread_transcript_questions(message_id,message_digest,project_id,state,message_json,response_id) VALUES (?,?,?,?,?,NULL)')
        .run(parsed.messageId, parsed.messageDigest, parsed.projectId, 'pending', stableJson(parsed));
      return { outcome: 'received' as const, question: this.#requireQuestion(parsed.messageId) };
    });
  }

  pending(projectId: string): ProjectHumanThreadQuestionRecord[] {
    return this.#questions(projectId, 'pending');
  }

  receipt(requestNonce: string): { receiptNonce: string; body: string; occurredAt: string; messageDigest: string } | undefined {
    const row = this.#db.prepare('SELECT request_nonce,receipt_nonce,receipt_body,occurred_at,message_digest FROM project_human_thread_transcript_receipts WHERE request_nonce=?').get(requestNonce) as ReceiptRow | undefined;
    return row ? { receiptNonce: row.receipt_nonce, body: row.receipt_body, occurredAt: row.occurred_at, messageDigest: row.message_digest } : undefined;
  }

  recordReceipt(requestNonce: string, receiptNonce: string, body: string, occurredAt: string, messageDigest: string): { receiptNonce: string; body: string; occurredAt: string; messageDigest: string } {
    requireId(requestNonce, 'question nonce');
    requireId(receiptNonce, 'question receipt nonce');
    if (!/^[a-f0-9]{64}$/.test(messageDigest)) throw new Error('Project human thread question digest is invalid.');
    return this.#transaction(() => {
      const existing = this.receipt(requestNonce);
      if (existing) {
        if (existing.receiptNonce !== receiptNonce || existing.body !== body || existing.messageDigest !== messageDigest) throw new Error('Project human thread question receipt conflict.');
        return existing;
      }
      this.#db.prepare('INSERT INTO project_human_thread_transcript_receipts(request_nonce,receipt_nonce,receipt_body,occurred_at,message_digest) VALUES (?,?,?,?,?)')
        .run(requestNonce, receiptNonce, body, occurredAt, messageDigest);
      return { receiptNonce, body, occurredAt, messageDigest };
    });
  }

  history(projectId: string): ProjectHumanThreadQuestionRecord[] {
    return this.#questions(projectId);
  }

  submitResponse(
    projectId: string,
    messageId: string,
    content: string,
    idempotencyKey: string,
    occurredAt = this.#now(),
  ): SubmitResponseResult {
    requireId(projectId, 'project id');
    requireId(messageId, 'message id');
    requireId(idempotencyKey, 'idempotency key');
    if (!content || content !== content.trim() || content.length > 6_000) throw new Error('Project human thread response content is invalid.');
    return this.#transaction(() => {
      const question = this.#requireQuestion(messageId);
      const parsedQuestion = question.message;
      if (parsedQuestion.projectId !== projectId) throw new Error('Project human thread question is not owned by this project.');
      this.#assertCurrent(parsedQuestion);
      if (parsedQuestion.kind === 'informational-notice') throw new Error('Project human thread informational notices do not accept responses.');
      if (parsedQuestion.kind === 'bounded-choice' && !parsedQuestion.choices.includes(content)) {
        throw new Error('Project human thread response must match one advertised choice.');
      }
      const contentDigest = messageDigest.content(content);
      const responseId = `project-human-thread-response:${sha256(messageId).slice(0, 48)}:${contentDigest.slice(0, 32)}`;
      const existing = this.#db.prepare('SELECT response_id,message_id,response_digest,response_json,state FROM project_human_thread_transcript_responses WHERE message_id=?').get(messageId) as ResponseRow | undefined;
      if (existing) {
        const existingResponse = parseProjectHumanThreadResponse(JSON.parse(existing.response_json));
        if (existingResponse.contentDigest !== contentDigest || existingResponse.idempotencyKey !== idempotencyKey) throw new Error('Project human thread response conflict.');
        return { outcome: 'replayed' as const, response: existingResponse };
      }
      if (question.state !== 'pending') throw new Error('Project human thread question is already answered.');
      const withoutDigest = {
        schemaVersion: 'roadex.project-human-thread-response.v1' as const,
        responseId,
        messageId,
        projectId,
        conversationId: parsedQuestion.conversationId,
        generation: parsedQuestion.generation,
        content,
        contentDigest,
        correlationId: parsedQuestion.correlationId,
        idempotencyKey,
        occurredAt,
      };
      const response = parseProjectHumanThreadResponse({
        ...withoutDigest,
        responseDigest: responseDigest.record(withoutDigest),
      });
      this.#insertEvent(`response:${response.responseId}`, 'response-submitted', { response }, occurredAt);
      this.#db.prepare('INSERT INTO project_human_thread_transcript_responses(response_id,message_id,response_digest,response_json,state) VALUES (?,?,?,?,?)')
        .run(response.responseId, response.messageId, response.responseDigest, stableJson(response), 'pending');
      this.#db.prepare('UPDATE project_human_thread_transcript_questions SET state=\'answered\',response_id=? WHERE message_id=?')
        .run(response.responseId, messageId);
      this.#db.prepare('INSERT INTO project_human_thread_transcript_outbox(event_id,response_json,response_digest,state) VALUES (?,?,?,\'pending\')')
        .run(`response:${response.responseId}`, stableJson(response), sha256(stableJson(response)));
      return { outcome: 'submitted' as const, response };
    });
  }

  pendingResponseOutbox(projectId?: string): ProjectHumanThreadResponseOutboxRecord[] {
    const rows = this.#db.prepare('SELECT event_id,response_json,response_digest,state FROM project_human_thread_transcript_outbox WHERE state=\'pending\' ORDER BY rowid').all() as unknown as OutboxRow[];
    const records = rows.map((row) => {
      if (sha256(row.response_json) !== row.response_digest) throw new Error('Project human thread response outbox digest is invalid.');
      return { eventId: row.event_id, response: parseProjectHumanThreadResponse(JSON.parse(row.response_json)) };
    });
    return projectId ? records.filter((record) => record.response.projectId === projectId) : records;
  }

  markResponseOutboxDelivered(eventId: string): void {
    requireId(eventId, 'response outbox event id');
    const result = this.#db.prepare("UPDATE project_human_thread_transcript_outbox SET state='delivered' WHERE event_id=? AND state='pending'").run(eventId);
    if (Number(result.changes) === 1) return;
    const existing = this.#db.prepare('SELECT state FROM project_human_thread_transcript_outbox WHERE event_id=?').get(eventId) as { state: string } | undefined;
    if (existing?.state === 'delivered') return;
    throw new Error('Project human thread response outbox record is missing.');
  }

  rebuild(): void {
    this.#transaction(() => {
      const rows = this.#db.prepare('SELECT event_id,type,payload_json,payload_digest,occurred_at FROM project_human_thread_transcript_events ORDER BY sequence').all() as unknown as EventRow[];
      this.#db.exec('DELETE FROM project_human_thread_transcript_questions; DELETE FROM project_human_thread_transcript_responses; DELETE FROM project_human_thread_transcript_nonces;');
      for (const row of rows) {
        if (sha256(row.payload_json) !== row.payload_digest) throw new Error('Project human thread transcript event digest is invalid.');
        const payload = JSON.parse(row.payload_json) as { message?: ProjectHumanThreadMessage; nonce?: string; requestTimestamp?: string; response?: ProjectHumanThreadResponse };
        if (row.type === 'question-received' && payload.message && payload.nonce && payload.requestTimestamp) {
          const message = parseProjectHumanThreadMessage(payload.message);
          this.#db.prepare('INSERT INTO project_human_thread_transcript_nonces(nonce,message_id,message_digest,request_timestamp) VALUES (?,?,?,?)').run(payload.nonce, message.messageId, message.messageDigest, payload.requestTimestamp);
          this.#db.prepare('INSERT INTO project_human_thread_transcript_questions(message_id,message_digest,project_id,state,message_json,response_id) VALUES (?,?,?,?,?,NULL)').run(message.messageId, message.messageDigest, message.projectId, 'pending', stableJson(message));
        } else if (row.type === 'response-submitted' && payload.response) {
          const response = parseProjectHumanThreadResponse(payload.response);
          this.#db.prepare('INSERT OR IGNORE INTO project_human_thread_transcript_responses(response_id,message_id,response_digest,response_json,state) VALUES (?,?,?,?,?)').run(response.responseId, response.messageId, response.responseDigest, stableJson(response), 'pending');
          this.#db.prepare('UPDATE project_human_thread_transcript_questions SET state=\'answered\',response_id=? WHERE message_id=?').run(response.responseId, response.messageId);
          this.#db.prepare('INSERT OR IGNORE INTO project_human_thread_transcript_outbox(event_id,response_json,response_digest,state) VALUES (?,?,?,\'pending\')').run(row.event_id, stableJson(response), sha256(stableJson(response)));
        }
      }
    });
  }

  close(): void { this.#db.close(); }

  #questions(projectId: string, state?: ProjectHumanThreadQuestionState): ProjectHumanThreadQuestionRecord[] {
    const rows = state
      ? this.#db.prepare('SELECT message_json,state,response_id FROM project_human_thread_transcript_questions WHERE project_id=? AND state=? ORDER BY rowid').all(projectId, state)
      : this.#db.prepare('SELECT message_json,state,response_id FROM project_human_thread_transcript_questions WHERE project_id=? ORDER BY rowid').all(projectId);
    return (rows as unknown as Array<{ message_json: string; state: ProjectHumanThreadQuestionState; response_id: string | null }>).map((row) => ({
      message: parseProjectHumanThreadMessage(JSON.parse(row.message_json)),
      state: row.state,
      ...(row.response_id ? { response: this.#response(row.response_id) } : {}),
    }));
  }

  #requireQuestion(messageId: string): ProjectHumanThreadQuestionRecord {
    const row = this.#db.prepare('SELECT message_json,state,response_id FROM project_human_thread_transcript_questions WHERE message_id=?').get(messageId) as { message_json: string; state: ProjectHumanThreadQuestionState; response_id: string | null } | undefined;
    if (!row) throw new Error('Project human thread question is missing.');
    return {
      message: parseProjectHumanThreadMessage(JSON.parse(row.message_json)),
      state: row.state,
      ...(row.response_id ? { response: this.#response(row.response_id) } : {}),
    };
  }

  #response(responseId: string): ProjectHumanThreadResponse {
    const row = this.#db.prepare('SELECT response_json FROM project_human_thread_transcript_responses WHERE response_id=?').get(responseId) as { response_json: string } | undefined;
    if (!row) throw new Error('Project human thread response is missing.');
    return parseProjectHumanThreadResponse(JSON.parse(row.response_json));
  }

  #assertCurrent(message: ProjectHumanThreadMessage): void {
    const binding = this.#current(message.projectId);
    if (!binding || binding.status !== 'active' || binding.conversationId !== message.conversationId || binding.generation !== message.generation) {
      throw new Error('Project human thread generation conflict.');
    }
  }

  #assertTimestampFresh(timestamp: string): void {
    const observed = Date.parse(timestamp);
    const now = Date.parse(this.#now());
    if (Number.isNaN(observed) || Number.isNaN(now) || Math.abs(now - observed) > this.#maxClockSkewMs) throw new Error('Project human thread question timestamp is stale.');
  }

  #insertEvent(eventId: string, type: TranscriptEventType, payload: Record<string, unknown>, occurredAt: string): void {
    requireId(eventId, 'transcript event id');
    const payloadJson = stableJson(payload);
    this.#db.prepare('INSERT INTO project_human_thread_transcript_events(event_id,type,payload_json,payload_digest,occurred_at) VALUES (?,?,?,?,?)').run(eventId, type, payloadJson, sha256(payloadJson), occurredAt);
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ } throw error; }
  }
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`Project human thread ${label} is invalid.`);
}
function requireTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(Date.parse(value))) throw new Error('Project human thread timestamp is invalid.');
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
