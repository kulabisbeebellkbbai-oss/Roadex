import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import {
  parseProjectHumanThreadQuestion,
  PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_DOMAIN,
  PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_SCHEMA,
  PROJECT_HUMAN_THREAD_QUESTION_REQUEST_DOMAIN,
  questionSha256,
  questionStableJson,
} from '../shared/projectHumanThreadQuestionContracts.js';
import { ProjectHumanThreadTranscriptStore } from './projectHumanThreadTranscriptStore.js';

export type QuestionReceiverResponse = { status: number; body: string; headers: Record<string, string> };
export type QuestionReceiverOptions = {
  secret?: string;
  now?: () => string;
  createNonce?: () => string;
};

const REQUEST_TIMESTAMP = 'x-overseer-question-timestamp';
const REQUEST_NONCE = 'x-overseer-question-nonce';
const REQUEST_SIGNATURE = 'x-overseer-question-signature';
const RECEIPT_TIMESTAMP = 'x-roadex-question-timestamp';
const RECEIPT_SIGNATURE = 'x-roadex-question-signature';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HEX = /^[a-f0-9]{64}$/;

export class ProjectHumanThreadQuestionReceiver {
  readonly #store: ProjectHumanThreadTranscriptStore;
  readonly #secret: string;
  readonly #now: () => string;
  readonly #createNonce: () => string;

  constructor(store: ProjectHumanThreadTranscriptStore, options: QuestionReceiverOptions = {}) {
    this.#store = store;
    this.#secret = options.secret ?? readRelaySecret();
    if (Buffer.byteLength(this.#secret) < 32) throw new Error('Project human thread question secret is unavailable.');
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createNonce = options.createNonce ?? (() => `receipt-${randomUUID()}`);
  }

  receive(body: string, headers: Record<string, string | string[] | undefined>): QuestionReceiverResponse {
    if (Buffer.byteLength(body) > 32_768 || !isCanonicalJson(body)) return reject(400, 'question_body_invalid');
    const timestamp = one(headers[REQUEST_TIMESTAMP]);
    const nonce = one(headers[REQUEST_NONCE]);
    const signature = one(headers[REQUEST_SIGNATURE]);
    if (!timestamp || !nonce || !signature || !ID.test(nonce) || !HEX.test(signature)) return reject(401, 'question_authentication_required');
    if (!verifyHmac(this.#secret, [PROJECT_HUMAN_THREAD_QUESTION_REQUEST_DOMAIN, timestamp, nonce, questionSha256(body)], signature)) return reject(401, 'question_authentication_invalid');
    let envelope: ReturnType<typeof parseProjectHumanThreadQuestion>;
    try { envelope = parseProjectHumanThreadQuestion(JSON.parse(body)); } catch { return reject(422, 'question_contract_invalid'); }

    const existing = this.#store.receipt(nonce);
    if (existing) {
      if (existing.messageDigest !== envelope.message.messageDigest) return reject(409, 'question_nonce_conflict');
      return this.#receiptResponse(existing.body, existing.occurredAt, nonce);
    }
    try {
      this.#store.receiveQuestion(envelope.message, nonce, timestamp);
      const occurredAt = this.#now();
      const receiptNonce = this.#createNonce();
      if (!ID.test(receiptNonce)) return reject(500, 'question_receipt_identity_invalid');
      const receiptBody = questionStableJson({
        schemaVersion: PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_SCHEMA,
        accepted: true,
        messageId: envelope.message.messageId,
        messageDigest: envelope.message.messageDigest,
        requestNonce: nonce,
        receiptNonce,
        occurredAt,
      });
      const stored = this.#store.recordReceipt(nonce, receiptNonce, receiptBody, occurredAt, envelope.message.messageDigest);
      return this.#receiptResponse(stored.body, stored.occurredAt, nonce);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/generation conflict|nonce conflict|question conflict/i.test(message)) return reject(409, 'question_conflict');
      if (/stale/i.test(message)) return reject(408, 'question_timestamp_stale');
      return reject(422, 'question_rejected');
    }
  }

  #receiptResponse(body: string, timestamp: string, requestNonce: string): QuestionReceiverResponse {
    return {
      status: 202,
      body,
      headers: {
        'content-type': 'application/json',
        [RECEIPT_TIMESTAMP]: timestamp,
        [RECEIPT_SIGNATURE]: hmac(this.#secret, [PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_DOMAIN, timestamp, requestNonce, questionSha256(body)]),
      },
    };
  }
}

function readRelaySecret(): string {
  const path = process.env.ROADEX_PROJECT_HUMAN_THREAD_RELAY_SECRET_FILE;
  if (!path || !path.startsWith('/') || path.includes('\0')) throw new Error('Project human thread question secret is unavailable.');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = fstatSync(fd);
    const lexical = lstatSync(path);
    if (!descriptor.isFile() || !lexical.isFile() || lexical.isSymbolicLink()
      || descriptor.uid !== process.getuid?.() || lexical.uid !== descriptor.uid
      || descriptor.dev !== lexical.dev || descriptor.ino !== lexical.ino
      || (descriptor.mode & 0o077) !== 0 || descriptor.size < 32 || descriptor.size > 4_096) {
      throw new Error('invalid secret file');
    }
    const raw = readFileSync(fd);
    const value = raw.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(raw) || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || Buffer.byteLength(value) < 32) throw new Error('invalid secret');
    return value;
  } catch {
    throw new Error('Project human thread question secret is unavailable.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isCanonicalJson(body: string): boolean {
  try { return questionStableJson(JSON.parse(body)) === body; } catch { return false; }
}
function one(value: string | string[] | undefined): string | undefined { return typeof value === 'string' ? value : undefined; }
function hmac(secret: string, parts: string[]): string { return createHmac('sha256', secret).update(parts.join('\n')).digest('hex'); }
function verifyHmac(secret: string, parts: string[], provided: string): boolean {
  const expected = Buffer.from(hmac(secret, parts), 'hex');
  const received = Buffer.from(provided, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
function reject(status: number, code: string): QuestionReceiverResponse {
  return { status, body: questionStableJson({ error: { code } }), headers: { 'content-type': 'application/json' } };
}
