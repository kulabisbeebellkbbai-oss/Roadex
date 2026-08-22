import { requestRoadex } from './sessionApi';

export type ProjectHumanThreadPublicResponse = {
  responseId: string;
  messageId: string;
  projectId: string;
  conversationId: string;
  generation: number;
  content: string;
  correlationId: string;
  occurredAt: string;
};

export type ProjectHumanThreadPublicQuestion = {
  messageId: string;
  projectId: string;
  conversationId: string;
  generation: number;
  kind: 'question' | 'bounded-choice' | 'clarification' | 'informational-notice';
  content: string;
  choices: string[];
  correlationId: string;
  occurredAt: string;
  state: 'pending' | 'answered';
  response?: ProjectHumanThreadPublicResponse;
};

export async function getProjectHumanThreadTranscript(
  token: string | undefined,
  projectId: string,
  view: 'pending' | 'history' = 'pending',
): Promise<ProjectHumanThreadPublicQuestion[]> {
  const suffix = view === 'history' ? '/history' : '';
  const payload = await requestRoadex<{ ok: true; questions: ProjectHumanThreadPublicQuestion[] }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/messages${suffix}`,
    { token },
  );
  return payload.questions;
}

export async function submitProjectHumanThreadResponse(
  token: string | undefined,
  projectId: string,
  messageId: string,
  content: string,
  idempotencyKey: string,
): Promise<ProjectHumanThreadPublicResponse> {
  const payload = await requestRoadex<{ ok: true; response: ProjectHumanThreadPublicResponse }>(
    `/Roadex/api/projects/${encodeURIComponent(projectId)}/human-thread/messages/${encodeURIComponent(messageId)}/respond`,
    {
      method: 'POST', token, body: { content }, headers: { 'idempotency-key': idempotencyKey },
    },
  );
  return payload.response;
}
