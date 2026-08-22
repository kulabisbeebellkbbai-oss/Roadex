import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  parseProjectHumanThreadBinding,
  parseProjectHumanThreadMessage,
  parseProjectHumanThreadResponse,
  type ProjectHumanThreadBinding,
  type ProjectHumanThreadMessage,
  type ProjectHumanThreadResponse,
} from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadOutboxRecord } from './projectHumanThreadStore.js';

const REQUEST_SCHEMA = 'roadex.overseer.project-human-thread-relay.v1' as const;
const RECEIPT_SCHEMA = 'overseer.roadex.project-human-thread-relay-receipt.v1' as const;
const REQUEST_DOMAIN = 'roadex.overseer.project-human-thread-relay.request.v1';
const RECEIPT_DOMAIN = 'overseer.roadex.project-human-thread-relay.receipt.v1';
export const PROJECT_HUMAN_THREAD_RELAY_ENDPOINT = 'http://127.0.0.1:8766/api/roadex/project-human-thread-relay';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

type RecordType = 'binding' | 'message' | 'response';
type RelayRecord = ProjectHumanThreadBinding | ProjectHumanThreadMessage | ProjectHumanThreadResponse;
type SenderResponse = { status: number; body: string; headers: Record<string, string> };
type Sender = (body: string, headers: Record<string, string>) => Promise<SenderResponse>;
type Options = {
  databasePath?: string;
  secret?: string;
  endpoint?: string;
  send?: Sender;
  now?: () => string;
  createNonce?: () => string;
};
type OutboxRow = {
  record_id: string;
  record_type: RecordType;
  record_digest: string;
  body: string;
  request_nonce: string;
  request_timestamp: string;
  state: 'pending' | 'sending' | 'delivered';
  attempts: number;
  claimed_at: string | null;
};
type ReceiptRow = {
  receipt_body: string;
  receipt_digest: string;
  receipt_timestamp: string;
  receipt_signature: string;
};
type BindingOutbox = {
  pendingOutbox(): ProjectHumanThreadOutboxRecord[];
  markOutboxDelivered(eventId: string): void;
};

const receiptSchema = z.object({
  schemaVersion: z.literal(RECEIPT_SCHEMA),
  accepted: z.literal(true),
  recordType: z.enum(['binding', 'message', 'response']),
  recordId: z.string().regex(ID),
  recordDigest: z.string().regex(DIGEST),
  requestNonce: z.string().regex(ID),
  receiptNonce: z.string().regex(ID),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export class ProjectHumanThreadRelay {
  readonly #db: DatabaseSync;
  readonly #secret: string;
  readonly #send: Sender;
  readonly #now: () => string;
  readonly #createNonce: () => string;

  constructor(options: Options = {}) {
    this.#secret = options.secret ?? readRelaySecret();
    validateSecret(this.#secret);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createNonce = options.createNonce ?? (() => `relay-${randomUUID()}`);
    const endpoint = options.endpoint ?? process.env.ROADEX_PROJECT_HUMAN_THREAD_RELAY_ENDPOINT ?? PROJECT_HUMAN_THREAD_RELAY_ENDPOINT;
    requireEndpoint(endpoint);
    this.#send = options.send ?? defaultSender(endpoint);
    this.#db = new DatabaseSync(options.databasePath
      ?? process.env.ROADEX_PROJECT_HUMAN_THREAD_RELAY_STATE_PATH
      ?? 'data/project-human-thread-relay.sqlite');
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS project_human_thread_relay_outbox (
        record_id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL CHECK(record_type IN ('binding','message','response')),
        record_digest TEXT NOT NULL CHECK(length(record_digest)=64),
        body TEXT NOT NULL,
        request_nonce TEXT NOT NULL UNIQUE,
        request_timestamp TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered')),
        attempts INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS project_human_thread_relay_receipts (
        record_id TEXT PRIMARY KEY,
        request_nonce TEXT NOT NULL UNIQUE,
        receipt_nonce TEXT NOT NULL UNIQUE,
        receipt_body TEXT NOT NULL,
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
        receipt_timestamp TEXT NOT NULL,
        receipt_signature TEXT NOT NULL CHECK(length(receipt_signature)=64)
      );
    `);
    const columns = this.#db.prepare('PRAGMA table_info(project_human_thread_relay_outbox)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'claimed_at')) {
      this.#db.exec('ALTER TABLE project_human_thread_relay_outbox ADD COLUMN claimed_at TEXT');
    }
    const receiptColumns = this.#db.prepare('PRAGMA table_info(project_human_thread_relay_receipts)').all() as unknown as Array<{ name: string }>;
    if (!receiptColumns.some((column) => column.name === 'receipt_timestamp')) {
      this.#db.exec("ALTER TABLE project_human_thread_relay_receipts ADD COLUMN receipt_timestamp TEXT NOT NULL DEFAULT ''");
      this.#db.exec("ALTER TABLE project_human_thread_relay_receipts ADD COLUMN receipt_signature TEXT NOT NULL DEFAULT ''");
    }
  }

  enqueueBinding(record: ProjectHumanThreadBinding, deliveryId = record.bindingId): OutboxRow {
    return this.enqueue('binding', record, deliveryId);
  }
  enqueueMessage(record: ProjectHumanThreadMessage): OutboxRow { return this.enqueue('message', record); }
  enqueueResponse(record: ProjectHumanThreadResponse): OutboxRow { return this.enqueue('response', record); }

  enqueue(recordType: RecordType, raw: RelayRecord, deliveryId?: string): OutboxRow {
    const record = parseRecord(recordType, raw);
    const identityValue = identity(recordType, record);
    const recordId = deliveryId ?? identityValue.recordId;
    const recordDigest = identityValue.recordDigest;
    if (!ID.test(recordId)) throw new Error('Project human thread relay record identity is invalid.');
    const body = relayStableJson({ schemaVersion: REQUEST_SCHEMA, recordType, recordId, recordDigest, record });
    const nonce = this.#createNonce();
    const timestamp = this.#now();
    if (!ID.test(nonce) || Number.isNaN(Date.parse(timestamp))) throw new Error('Project human thread relay identity is invalid.');
    const existing = this.#row(recordId);
    if (existing) {
      if (existing.record_type !== recordType || existing.record_digest !== recordDigest || existing.body !== body) {
        throw new Error('Project human thread relay record conflict.');
      }
      return existing;
    }
    this.#db.prepare(`INSERT INTO project_human_thread_relay_outbox(
      record_id,record_type,record_digest,body,request_nonce,request_timestamp,state
    ) VALUES (?,?,?,?,?,?,'pending')`).run(recordId, recordType, recordDigest, body, nonce, timestamp);
    return this.#requireRow(recordId);
  }

  async deliver(recordId: string): Promise<OutboxRow> {
    const existing = this.#requireRow(recordId);
    if (existing.state === 'delivered') {
      this.#verifyStoredReceipt(existing);
      return existing;
    }
    const claimed = this.#claim(recordId);
    const headers = requestHeaders(this.#secret, claimed);
    try {
      const response = await this.#send(claimed.body, headers);
      const receipt = verifyReceipt(this.#secret, claimed, response);
      this.#transaction(() => {
        const current = this.#requireRow(recordId);
        if (current.state !== 'sending' || current.request_nonce !== claimed.request_nonce) {
          throw new Error('Project human thread relay claim changed.');
        }
        this.#db.prepare(`INSERT INTO project_human_thread_relay_receipts(
          record_id,request_nonce,receipt_nonce,receipt_body,receipt_digest,receipt_timestamp,receipt_signature
        ) VALUES (?,?,?,?,?,?,?)`).run(
          recordId, claimed.request_nonce, receipt.receiptNonce,
          response.body, relaySha256(response.body),
          response.headers['x-overseer-relay-timestamp'], response.headers['x-overseer-relay-signature'],
        );
        this.#db.prepare("UPDATE project_human_thread_relay_outbox SET state='delivered',claimed_at=NULL WHERE record_id=? AND state='sending'")
          .run(recordId);
      });
      return this.#requireRow(recordId);
    } catch (error) {
      this.#db.prepare("UPDATE project_human_thread_relay_outbox SET state='pending',claimed_at=NULL WHERE record_id=? AND state='sending'")
        .run(recordId);
      throw error;
    }
  }

  async retryPending(): Promise<{ delivered: number; failed: number }> {
    const cutoff = new Date(Date.parse(this.#now()) - 60_000).toISOString();
    this.#db.prepare("UPDATE project_human_thread_relay_outbox SET state='pending',claimed_at=NULL WHERE state='sending' AND claimed_at<?")
      .run(cutoff);
    const ids = this.#db.prepare("SELECT record_id FROM project_human_thread_relay_outbox WHERE state='pending' ORDER BY rowid")
      .all() as unknown as Array<{ record_id: string }>;
    let delivered = 0;
    let failed = 0;
    for (const { record_id: recordId } of ids) {
      try { await this.deliver(recordId); delivered += 1; } catch { failed += 1; }
    }
    return { delivered, failed };
  }

  close(): void { this.#db.close(); }

  #claim(recordId: string): OutboxRow {
    return this.#transaction(() => {
      const row = this.#requireRow(recordId);
      if (row.state === 'delivered') return row;
      if (row.state !== 'pending') throw new Error('Project human thread relay record is already claimed.');
      const result = this.#db.prepare("UPDATE project_human_thread_relay_outbox SET state='sending',attempts=attempts+1,claimed_at=? WHERE record_id=? AND state='pending'")
        .run(this.#now(), recordId);
      if (Number(result.changes) !== 1) throw new Error('Project human thread relay record is already claimed.');
      return this.#requireRow(recordId);
    });
  }

  #row(recordId: string): OutboxRow | undefined {
    return this.#db.prepare('SELECT * FROM project_human_thread_relay_outbox WHERE record_id=?').get(recordId) as OutboxRow | undefined;
  }
  #requireRow(recordId: string): OutboxRow {
    const row = this.#row(recordId);
    if (!row) throw new Error('Project human thread relay record is missing.');
    return row;
  }
  #verifyStoredReceipt(row: OutboxRow): void {
    const receipt = this.#db.prepare(`
      SELECT receipt_body,receipt_digest,receipt_timestamp,receipt_signature
      FROM project_human_thread_relay_receipts WHERE record_id=? AND request_nonce=?
    `).get(row.record_id, row.request_nonce) as ReceiptRow | undefined;
    if (!receipt || relaySha256(receipt.receipt_body) !== receipt.receipt_digest) {
      throw new Error('Project human thread relay stored receipt is invalid.');
    }
    verifyReceipt(this.#secret, row, {
      status: 202,
      body: receipt.receipt_body,
      headers: {
        'x-overseer-relay-timestamp': receipt.receipt_timestamp,
        'x-overseer-relay-signature': receipt.receipt_signature,
      },
    });
  }
  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* no active transaction */ } throw error; }
  }
}

export class ProjectHumanThreadRelayCoordinator {
  readonly #store: BindingOutbox;
  readonly #relay: ProjectHumanThreadRelay;

  constructor(store: BindingOutbox, relay: ProjectHumanThreadRelay) {
    this.#store = store;
    this.#relay = relay;
  }

  async retryBindings(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const entry of this.#store.pendingOutbox()) {
      try {
        this.#relay.enqueueBinding(entry.binding, entry.eventId);
        const result = await this.#relay.deliver(entry.eventId);
        if (result.state !== 'delivered') throw new Error('Project human thread binding receipt is incomplete.');
        this.#store.markOutboxDelivered(entry.eventId);
        delivered += 1;
      } catch {
        failed += 1;
      }
    }
    return { delivered, failed };
  }
}

function parseRecord(recordType: RecordType, raw: RelayRecord): RelayRecord {
  if (recordType === 'binding') return parseProjectHumanThreadBinding(raw);
  if (recordType === 'message') return parseProjectHumanThreadMessage(raw);
  return parseProjectHumanThreadResponse(raw);
}
function identity(recordType: RecordType, record: RelayRecord): { recordId: string; recordDigest: string } {
  if (recordType === 'binding') {
    const binding = record as ProjectHumanThreadBinding;
    return { recordId: binding.bindingId, recordDigest: binding.recordDigest };
  }
  if (recordType === 'message') {
    const message = record as ProjectHumanThreadMessage;
    return { recordId: message.messageId, recordDigest: message.messageDigest };
  }
  const response = record as ProjectHumanThreadResponse;
  return { recordId: response.responseId, recordDigest: response.responseDigest };
}
function requestHeaders(secret: string, row: OutboxRow): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-roadex-relay-timestamp': row.request_timestamp,
    'x-roadex-relay-nonce': row.request_nonce,
    'x-roadex-relay-signature': hmac(secret, [REQUEST_DOMAIN, row.request_timestamp, row.request_nonce, relaySha256(row.body)]),
  };
}
function verifyReceipt(secret: string, row: OutboxRow, response: SenderResponse): z.infer<typeof receiptSchema> {
  if (response.status !== 202 || relayStableJson(JSON.parse(response.body)) !== response.body) {
    throw new Error('Project human thread relay receipt is invalid.');
  }
  const receipt = receiptSchema.parse(JSON.parse(response.body));
  if (receipt.recordType !== row.record_type || receipt.recordId !== row.record_id
    || receipt.recordDigest !== row.record_digest || receipt.requestNonce !== row.request_nonce) {
    throw new Error('Project human thread relay receipt binding is invalid.');
  }
  const timestamp = response.headers['x-overseer-relay-timestamp'];
  const signature = response.headers['x-overseer-relay-signature'];
  if (timestamp !== receipt.occurredAt || !DIGEST.test(signature ?? '')) {
    throw new Error('Project human thread relay receipt authority is invalid.');
  }
  const expected = hmac(secret, [RECEIPT_DOMAIN, timestamp, row.request_nonce, relaySha256(response.body)]);
  if (!equalHex(expected, signature)) throw new Error('Project human thread relay receipt authority is invalid.');
  return receipt;
}
function defaultSender(endpoint: string): Sender {
  return async (body, headers) => {
    const response = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody) > 32_768) throw new Error('Project human thread relay receipt is too large.');
    return { status: response.status, body: responseBody, headers: Object.fromEntries(response.headers.entries()) };
  };
}
function requireEndpoint(value: string): void {
  if (value !== PROJECT_HUMAN_THREAD_RELAY_ENDPOINT) throw new Error('Project human thread relay endpoint is invalid.');
}
function readRelaySecret(): string {
  const path = process.env.ROADEX_PROJECT_HUMAN_THREAD_RELAY_SECRET_FILE;
  if (!path || !path.startsWith('/') || path.includes('\0')) throw new Error('Project human thread relay secret is unavailable.');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = fstatSync(fd);
    const lexical = lstatSync(path);
    if (!descriptor.isFile() || !lexical.isFile() || lexical.isSymbolicLink()
      || descriptor.uid !== process.getuid?.() || lexical.uid !== descriptor.uid
      || descriptor.dev !== lexical.dev || descriptor.ino !== lexical.ino
      || (descriptor.mode & 0o077) !== 0 || descriptor.size < 32 || descriptor.size > 4_096) throw new Error('invalid secret file');
    const raw = readFileSync(fd);
    const value = raw.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(raw)) throw new Error('invalid secret encoding');
    validateSecret(value);
    return value;
  } catch {
    throw new Error('Project human thread relay secret is unavailable.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function validateSecret(value: string): void {
  if (Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4_096 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Project human thread relay secret is unavailable.');
  }
}
function hmac(secret: string, parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
}
function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function relaySha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function relayStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(relayStableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${relayStableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
