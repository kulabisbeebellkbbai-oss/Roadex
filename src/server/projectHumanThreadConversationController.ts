import { z } from 'zod';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadTurn } from '../shared/projectHumanThreadConversationContracts.js';
import type { ProjectHumanThreadConversationStore } from './projectHumanThreadConversationStore.js';

type OwnedProject = { projectId: string; root?: string };
type Dependencies = { resolveOwnedProject(user: UserProfile, projectId: string): OwnedProject | undefined };
const bodySchema = z.object({ content: z.string().trim().min(1).max(6_000), correlationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/) }).strict();

export class ProjectHumanThreadConversationController {
  readonly #store: ProjectHumanThreadConversationStore;
  readonly #deps: Dependencies;
  readonly #current: (projectId: string, projectRoot?: string) => ProjectHumanThreadBinding | undefined;

  constructor(store: ProjectHumanThreadConversationStore, dependencies: Dependencies, current?: (projectId: string, projectRoot?: string) => ProjectHumanThreadBinding | undefined) {
    this.#store = store;
    this.#deps = dependencies;
    this.#current = current ?? (() => undefined);
  }

  async read(user: UserProfile, projectId: string): Promise<{ canonicalProjectId: string; conversationId: string; generation: number; hasEarlierTurns: boolean; turns: Array<ReturnType<typeof publicTurn>> }> {
    const project = this.#owned(user, projectId);
    const binding = this.#current(project.projectId, project.root) ?? this.#current(project.projectId);
    if (!binding || binding.status !== 'active') throw new Error('Project human thread is unavailable.');
    const history = this.#store.historyForBinding(binding.projectId, binding.conversationId, binding.generation);
    return {
      canonicalProjectId: binding.projectId,
      conversationId: binding.conversationId,
      generation: binding.generation,
      hasEarlierTurns: history.hasEarlierTurns,
      turns: history.turns.map(publicTurn),
    };
  }

  async enqueue(user: UserProfile, projectId: string, idempotencyKey: string, payload: unknown): Promise<ReturnType<typeof publicTurn>> {
    const project = this.#owned(user, projectId);
    const parsed = bodySchema.safeParse(payload);
    if (!parsed.success) throw new Error('Project human thread turn request is invalid.');
    const body = parsed.data;
    const binding = this.#current(project.projectId, project.root) ?? this.#current(project.projectId);
    if (!binding || binding.status !== 'active') throw new Error('Project human thread is unavailable.');
    return publicTurn(this.#store.enqueue(user.id, binding, body.content, idempotencyKey, body.correlationId).turn);
  }

  #owned(user: UserProfile, projectId: string): OwnedProject {
    if (!user.roles.includes('user')) throw new Error('Project not found.');
    const project = this.#deps.resolveOwnedProject(user, projectId);
    if (!project || project.projectId !== projectId) throw new Error('Project not found.');
    return project;
  }
}

function publicTurn(turn: ProjectHumanThreadTurn) {
  return {
    turnId: turn.turnId, projectId: turn.projectId, conversationId: turn.conversationId,
    generation: turn.generation, content: turn.content, correlationId: turn.correlationId,
    idempotencyKey: turn.idempotencyKey, state: turn.state,
    ...(turn.assistantOutput !== undefined ? { assistantOutput: turn.assistantOutput } : {}),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
    createdAt: turn.createdAt, updatedAt: turn.updatedAt,
  };
}
