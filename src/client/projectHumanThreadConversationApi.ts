import { requestRoadex } from './sessionApi';

export type ProjectHumanThreadTurnState = 'queued' | 'running' | 'completed' | 'failed' | 'reconciliation-required';
export type ProjectHumanThreadTurnPublic = {
  turnId: string;
  projectId: string;
  conversationId: string;
  generation: number;
  content: string;
  correlationId: string;
  idempotencyKey: string;
  state: ProjectHumanThreadTurnState;
  assistantOutput?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type ProjectHumanThreadConversationPublic = {
  requestedProjectId: string;
  canonicalProjectId: string;
  conversationId: string;
  generation: number;
  hasEarlierTurns: boolean;
  turns: ProjectHumanThreadTurnPublic[];
};

export async function getProjectHumanThreadConversation(token: string | undefined, projectId: string): Promise<ProjectHumanThreadConversationPublic> {
  const payload = await requestRoadex<{ ok: true } & ProjectHumanThreadConversationPublic>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/conversation`, { token },
  );
  if (!isConversation(payload, projectId)) throw new Error('Project human thread conversation response is invalid.');
  return payload;
}

export async function submitProjectHumanThreadTurn(
  token: string | undefined,
  projectId: string,
  content: string,
  correlationId: string,
  idempotencyKey: string,
): Promise<ProjectHumanThreadTurnPublic> {
  const payload = await requestRoadex<{ ok: true; requestedProjectId: string; canonicalProjectId: string; turn: ProjectHumanThreadTurnPublic }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/conversation/messages`,
    { method: 'POST', token, body: { content, correlationId }, headers: { 'idempotency-key': idempotencyKey } },
  );
  if (!isExactRecord(payload, ['ok', 'requestedProjectId', 'canonicalProjectId', 'turn']) || payload.ok !== true
    || payload.requestedProjectId !== projectId || !isId(payload.canonicalProjectId)
    || !isTurn(payload.turn, payload.canonicalProjectId)
    || payload.turn.content !== content
    || payload.turn.correlationId !== correlationId
    || payload.turn.idempotencyKey !== idempotencyKey) {
    throw new Error('Project human thread turn response is invalid.');
  }
  return payload.turn;
}

function isConversation(value: unknown, projectId: string): value is ProjectHumanThreadConversationPublic & { ok: true } {
  if (!isExactRecord(value, ['ok', 'requestedProjectId', 'canonicalProjectId', 'conversationId', 'generation', 'hasEarlierTurns', 'turns']) || value.ok !== true) return false;
  const record = value as Record<string, unknown>;
  return record.requestedProjectId === projectId && isId(record.canonicalProjectId)
    && isUuid(record.conversationId) && isPositiveInteger(record.generation) && typeof record.hasEarlierTurns === 'boolean'
    && Array.isArray(record.turns) && record.turns.length <= 500
    && record.turns.every((turn) => isTurn(turn, record.canonicalProjectId as string, record.conversationId, record.generation));
}
function isTurn(value: unknown, projectId: string, conversationId?: unknown, generation?: unknown): value is ProjectHumanThreadTurnPublic {
  if (!isExactRecord(value, [
    'turnId', 'projectId', 'conversationId', 'generation', 'content', 'correlationId',
    'idempotencyKey', 'state', 'assistantOutput?', 'error?', 'createdAt', 'updatedAt',
  ])) return false;
  const turn = value as Record<string, unknown>;
  const state = String(turn.state);
  const hasOutput = Object.prototype.hasOwnProperty.call(turn, 'assistantOutput');
  const hasError = Object.prototype.hasOwnProperty.call(turn, 'error');
  return turn.projectId === projectId && (conversationId === undefined || turn.conversationId === conversationId)
    && (generation === undefined || turn.generation === generation)
    && isId(turn.turnId) && isUuid(turn.conversationId) && isPositiveInteger(turn.generation)
    && typeof turn.content === 'string' && turn.content === turn.content.trim() && turn.content.length >= 1 && turn.content.length <= 6_000
    && isId(turn.correlationId) && isId(turn.idempotencyKey)
    && ['queued', 'running', 'completed', 'failed', 'reconciliation-required'].includes(state)
    && isTimestamp(turn.createdAt) && isTimestamp(turn.updatedAt)
    && (!hasOutput || typeof turn.assistantOutput === 'string' && turn.assistantOutput.length <= 32_768)
    && (!hasError || typeof turn.error === 'string' && turn.error.length >= 1 && turn.error.length <= 1_000)
    && (state === 'completed' ? hasOutput && !hasError : state === 'failed' || state === 'reconciliation-required' ? hasError && !hasOutput : !hasOutput && !hasError);
}

function isExactRecord(value: unknown, allowed: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const required = new Set(allowed.filter((key) => !key.endsWith('?')));
  const permitted = new Set(allowed.map((key) => key.replace(/\?$/, '')));
  const keys = Object.keys(value);
  return keys.every((key) => permitted.has(key)) && [...required].every((key) => keys.includes(key));
}
function isId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value); }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
