import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  parseProjectHumanThreadMessage,
  type ProjectHumanThreadMessage,
} from './projectHumanThreadContracts.js';

export const PROJECT_HUMAN_THREAD_QUESTION_SCHEMA = 'overseer.project-human-thread-question.v1' as const;
export const PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_SCHEMA = 'roadex.overseer.project-human-thread.question-receipt.v1' as const;
export const PROJECT_HUMAN_THREAD_QUESTION_REQUEST_DOMAIN = 'overseer.roadex.project-human-thread.question.v1' as const;
export const PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_DOMAIN = 'roadex.overseer.project-human-thread.question-receipt.v1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

const questionEnvelopeSchema = z.object({
  schemaVersion: z.literal(PROJECT_HUMAN_THREAD_QUESTION_SCHEMA),
  message: z.unknown(),
}).strict();

const questionReceiptSchema = z.object({
  schemaVersion: z.literal(PROJECT_HUMAN_THREAD_QUESTION_RECEIPT_SCHEMA),
  accepted: z.literal(true),
  messageId: id,
  messageDigest: digest,
  requestNonce: id,
  receiptNonce: id,
  occurredAt: timestamp,
}).strict();

export type ProjectHumanThreadQuestionEnvelope = {
  schemaVersion: typeof PROJECT_HUMAN_THREAD_QUESTION_SCHEMA;
  message: ProjectHumanThreadMessage;
};
export type ProjectHumanThreadQuestionReceipt = z.infer<typeof questionReceiptSchema>;

export function parseProjectHumanThreadQuestion(value: unknown): ProjectHumanThreadQuestionEnvelope {
  const parsed = questionEnvelopeSchema.parse(value);
  return {
    schemaVersion: parsed.schemaVersion,
    message: parseProjectHumanThreadMessage(parsed.message),
  };
}

export function parseProjectHumanThreadQuestionReceipt(value: unknown): ProjectHumanThreadQuestionReceipt {
  return questionReceiptSchema.parse(value);
}

export function questionRecordDigest(message: ProjectHumanThreadMessage): string {
  return message.messageDigest;
}

export function questionStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(questionStableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${questionStableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function questionSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
