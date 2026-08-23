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
  conversationId: string;
  generation: number;
  turns: ProjectHumanThreadTurnPublic[];
};

export async function getProjectHumanThreadConversation(token: string | undefined, projectId: string): Promise<ProjectHumanThreadConversationPublic> {
  const payload = await requestRoadex<{ ok: true } & ProjectHumanThreadConversationPublic>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/conversation`, { token },
  );
  if (!payload.ok || !isConversation(payload, projectId)) throw new Error('Project human thread conversation response is invalid.');
  return payload;
}

export async function submitProjectHumanThreadTurn(
  token: string | undefined,
  projectId: string,
  content: string,
  correlationId: string,
  idempotencyKey: string,
): Promise<ProjectHumanThreadTurnPublic> {
  const payload = await requestRoadex<{ ok: true; turn: ProjectHumanThreadTurnPublic }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/conversation/messages`,
    { method: 'POST', token, body: { content, correlationId }, headers: { 'idempotency-key': idempotencyKey } },
  );
  if (!payload.ok || !isTurn(payload.turn, projectId)) throw new Error('Project human thread turn response is invalid.');
  return payload.turn;
}

function isConversation(value: unknown, projectId: string): value is ProjectHumanThreadConversationPublic & { ok: true } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.conversationId === 'string' && typeof record.generation === 'number'
    && Array.isArray(record.turns) && record.turns.every((turn) => isTurn(turn, projectId));
}
function isTurn(value: unknown, projectId: string): value is ProjectHumanThreadTurnPublic {
  if (!value || typeof value !== 'object') return false;
  const turn = value as Record<string, unknown>;
  return turn.projectId === projectId && typeof turn.turnId === 'string' && typeof turn.conversationId === 'string'
    && typeof turn.generation === 'number' && typeof turn.content === 'string' && typeof turn.correlationId === 'string'
    && typeof turn.idempotencyKey === 'string' && ['queued', 'running', 'completed', 'failed', 'reconciliation-required'].includes(String(turn.state))
    && typeof turn.createdAt === 'string' && typeof turn.updatedAt === 'string';
}
