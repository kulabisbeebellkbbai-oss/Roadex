import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROJECT_HUMAN_THREAD_TURN_SCHEMA = 'roadex.project-human-thread-turn.v1' as const;
const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/);
const TIMESTAMP = z.string().datetime({ offset: true });

const turnShape = {
  schemaVersion: z.literal(PROJECT_HUMAN_THREAD_TURN_SCHEMA),
  turnId: ID,
  actorId: ID,
  projectId: ID,
  conversationId: UUID,
  generation: z.number().int().positive(),
  content: z.string().min(1).max(6_000).refine((value) => value === value.trim()),
  contentDigest: DIGEST,
  correlationId: ID,
  idempotencyKey: ID,
  state: z.enum(['queued', 'running', 'completed', 'failed', 'reconciliation-required']),
  assistantOutput: z.string().max(32_768).optional(),
  error: z.string().max(1_000).optional(),
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const withoutDigest = z.object(turnShape).strict().superRefine((value, context) => {
  if (sha256(value.content) !== value.contentDigest) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project human thread turn content digest is invalid.' });
});
const turnSchema = z.object({ ...turnShape, turnDigest: DIGEST }).strict().superRefine((value, context) => {
  if (sha256(value.content) !== value.contentDigest || turnDigest.record(valueWithoutDigest(value)) !== value.turnDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project human thread turn digest is invalid.' });
  }
});

export type ProjectHumanThreadTurn = z.infer<typeof turnSchema>;

export const turnDigest = Object.freeze({
  content: sha256,
  record(value: unknown): string {
    return sha256(stableJson(withoutDigest.parse(value)));
  },
});

export function parseProjectHumanThreadTurn(value: unknown): ProjectHumanThreadTurn {
  return turnSchema.parse(value);
}

function valueWithoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.turnDigest;
  return copy;
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
