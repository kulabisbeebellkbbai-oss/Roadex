import { z } from 'zod';
import type { UserProfile } from '../shared/sessionContracts.js';
import { ProjectHumanThreadTranscriptStore, type ProjectHumanThreadQuestionRecord } from './projectHumanThreadTranscriptStore.js';

type OwnedProject = { projectId: string; root?: string };
type Dependencies = {
  resolveOwnedProject(user: UserProfile, projectId: string): OwnedProject | undefined;
  resolveHumanThreadProjectId?: (project: OwnedProject) => string;
};
const responseBody = z.object({ content: z.string().trim().min(1).max(6_000) }).strict();

export class ProjectHumanThreadTranscriptController {
  readonly #store: ProjectHumanThreadTranscriptStore;
  readonly #deps: Dependencies;

  constructor(store: ProjectHumanThreadTranscriptStore, dependencies: Dependencies) {
    this.#store = store;
    this.#deps = dependencies;
  }

  pending(user: UserProfile, projectId: string): ReturnType<typeof publicQuestion>[] {
    const project = this.#owned(user, projectId);
    return this.#store.pending(this.#threadProjectId(project)).map(publicQuestion);
  }

  history(user: UserProfile, projectId: string): ReturnType<typeof publicQuestion>[] {
    const project = this.#owned(user, projectId);
    return this.#store.history(this.#threadProjectId(project)).map(publicQuestion);
  }

  canonicalProjectId(user: UserProfile, projectId: string): string {
    return this.#threadProjectId(this.#owned(user, projectId));
  }

  submit(user: UserProfile, projectId: string, messageId: string, idempotencyKey: string, payload: unknown): ReturnType<typeof publicResponse> {
    const project = this.#owned(user, projectId);
    const body = responseBody.parse(payload);
    return publicResponse(this.#store.submitResponse(this.#threadProjectId(project), messageId, body.content, idempotencyKey).response);
  }

  #owned(user: UserProfile, projectId: string): OwnedProject {
    if (!user.roles.includes('user')) throw new Error('Project not found.');
    const project = this.#deps.resolveOwnedProject(user, projectId);
    if (!project || project.projectId !== projectId) throw new Error('Project not found.');
    return project;
  }

  #threadProjectId(project: OwnedProject): string {
    return this.#deps.resolveHumanThreadProjectId?.(project) ?? project.projectId;
  }
}

function publicQuestion(record: ProjectHumanThreadQuestionRecord) {
  return {
    messageId: record.message.messageId,
    projectId: record.message.projectId,
    conversationId: record.message.conversationId,
    generation: record.message.generation,
    kind: record.message.kind,
    content: record.message.content,
    choices: record.message.choices,
    correlationId: record.message.correlationId,
    occurredAt: record.message.occurredAt,
    state: record.state,
    ...(record.response ? { response: publicResponse(record.response) } : {}),
  };
}

function publicResponse(response: {
  responseId: string;
  messageId: string;
  projectId: string;
  conversationId: string;
  generation: number;
  content: string;
  correlationId: string;
  occurredAt: string;
}) {
  return {
    responseId: response.responseId,
    messageId: response.messageId,
    projectId: response.projectId,
    conversationId: response.conversationId,
    generation: response.generation,
    content: response.content,
    correlationId: response.correlationId,
    occurredAt: response.occurredAt,
  };
}
