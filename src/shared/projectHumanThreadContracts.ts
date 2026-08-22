import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROJECT_HUMAN_THREAD_BINDING_SCHEMA = 'roadex.project-human-thread-binding.v1' as const;
export const PROJECT_HUMAN_THREAD_MESSAGE_SCHEMA = 'roadex.project-human-thread-message.v1' as const;
export const PROJECT_HUMAN_THREAD_RESPONSE_SCHEMA = 'roadex.project-human-thread-response.v1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const root = z.object({
  canonicalPath: z.string().min(1).max(4_096).refine((value) => value.startsWith('/') && value === value.trim()),
  dev: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),
  ino: z.string().regex(/^[1-9][0-9]{0,19}$/),
}).strict();

const bindingShape = {
  schemaVersion: z.literal(PROJECT_HUMAN_THREAD_BINDING_SCHEMA),
  bindingId: id,
  projectId: id,
  root,
  purpose: z.literal('human-interaction'),
  conversationId: uuid,
  generation: z.number().int().positive(),
  status: z.enum(['active', 'unavailable', 'replacement-pending', 'retired']),
  predecessorGeneration: z.number().int().positive().nullable(),
  creationMode: z.enum(['created', 'adopted']),
  provenanceDigest: digest,
  createdAt: timestamp,
  updatedAt: timestamp,
  retiredAt: timestamp.nullable(),
};
function refineBinding(value: z.infer<z.ZodObject<typeof bindingShape>>, context: z.RefinementCtx): void {
  if (value.bindingId !== `project-human-thread:${value.projectId}:${value.generation}`
    || (value.generation === 1 ? value.predecessorGeneration !== null : value.predecessorGeneration !== value.generation - 1)
    || (value.status === 'retired') !== (value.retiredAt !== null)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
    || (value.retiredAt !== null && Date.parse(value.retiredAt) < Date.parse(value.createdAt))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project human thread binding lineage is invalid.' });
  }
}
const bindingWithoutDigestSchema = z.object(bindingShape).strict().superRefine(refineBinding);

const bindingSchema = z.object({ ...bindingShape, recordDigest: digest }).strict().superRefine(refineBinding);
export type ProjectHumanThreadBinding = z.infer<typeof bindingSchema>;

const messageShape = {
  schemaVersion: z.literal(PROJECT_HUMAN_THREAD_MESSAGE_SCHEMA),
  messageId: id,
  projectId: id,
  conversationId: uuid,
  generation: z.number().int().positive(),
  kind: z.enum(['question', 'bounded-choice', 'clarification', 'informational-notice']),
  content: z.string().min(1).max(6_000).refine((value) => value === value.trim()),
  choices: z.array(z.string().min(1).max(160).refine((value) => value === value.trim())).max(20),
  contentDigest: digest,
  correlationId: id,
  idempotencyKey: id,
  occurredAt: timestamp,
};
function refineMessage(value: z.infer<z.ZodObject<typeof messageShape>>, context: z.RefinementCtx): void {
  if ((value.kind === 'bounded-choice') !== (value.choices.length > 0)
    || new Set(value.choices).size !== value.choices.length
    || sha256(value.content) !== value.contentDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project human thread message content is invalid.' });
  }
}
const messageWithoutDigestSchema = z.object(messageShape).strict().superRefine(refineMessage);
const messageSchema = z.object({ ...messageShape, messageDigest: digest }).strict().superRefine(refineMessage);
export type ProjectHumanThreadMessage = z.infer<typeof messageSchema>;

const responseShape = {
  schemaVersion: z.literal(PROJECT_HUMAN_THREAD_RESPONSE_SCHEMA),
  responseId: id,
  messageId: id,
  projectId: id,
  conversationId: uuid,
  generation: z.number().int().positive(),
  content: z.string().min(1).max(6_000).refine((value) => value === value.trim()),
  contentDigest: digest,
  correlationId: id,
  idempotencyKey: id,
  occurredAt: timestamp,
};
function refineResponse(value: z.infer<z.ZodObject<typeof responseShape>>, context: z.RefinementCtx): void {
  if (sha256(value.content) !== value.contentDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project human thread response content is invalid.' });
  }
}
const responseWithoutDigestSchema = z.object(responseShape).strict().superRefine(refineResponse);
const responseSchema = z.object({ ...responseShape, responseDigest: digest }).strict().superRefine(refineResponse);
export type ProjectHumanThreadResponse = z.infer<typeof responseSchema>;

export function bindingDigest(value: z.input<typeof bindingWithoutDigestSchema>): string {
  return sha256(stableJson(bindingWithoutDigestSchema.parse(value)));
}

export const messageDigest = Object.freeze({
  content: sha256,
  record(value: z.input<typeof messageWithoutDigestSchema>): string {
    return sha256(stableJson(messageWithoutDigestSchema.parse(value)));
  },
});

export const responseDigest = Object.freeze({
  content: sha256,
  record(value: z.input<typeof responseWithoutDigestSchema>): string {
    return sha256(stableJson(responseWithoutDigestSchema.parse(value)));
  },
});

export function parseProjectHumanThreadBinding(value: unknown): ProjectHumanThreadBinding {
  const parsed = bindingSchema.parse(value);
  if (bindingDigest(without(parsed, 'recordDigest')) !== parsed.recordDigest) {
    throw new Error('Project human thread binding digest is invalid.');
  }
  return parsed;
}

export function parseProjectHumanThreadMessage(value: unknown): ProjectHumanThreadMessage {
  const parsed = messageSchema.parse(value);
  if (messageDigest.record(without(parsed, 'messageDigest')) !== parsed.messageDigest) {
    throw new Error('Project human thread message digest is invalid.');
  }
  return parsed;
}

export function parseProjectHumanThreadResponse(value: unknown): ProjectHumanThreadResponse {
  const parsed = responseSchema.parse(value);
  if (responseDigest.record(without(parsed, 'responseDigest')) !== parsed.responseDigest) {
    throw new Error('Project human thread response digest is invalid.');
  }
  return parsed;
}

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
