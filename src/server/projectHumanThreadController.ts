import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { UserProfile } from '../shared/sessionContracts.js';
import type { ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';

type OwnedProject = { projectId: string; root: string; activeRun: boolean };
type Service = {
  current(projectId: string): ProjectHumanThreadBinding | undefined;
  history(projectId: string): ProjectHumanThreadBinding[];
  candidates(projectRoot: string): unknown[];
  createMissing(input: ServiceInput): Promise<unknown>;
  adopt(input: ServiceInput & { conversationId: string }): Promise<unknown>;
  recover(projectId: string, expectedGeneration: number, idempotencyKey: string): unknown;
  replace(input: ServiceInput & { expectedGeneration: number; reason: string }): Promise<unknown>;
  replacementIntent(projectId: string): {
    state: 'prepared' | 'completed';
    eventId: string;
    idempotencyKey: string;
    expectedGeneration: number;
    projectRoot: string;
    provenanceDigest: string;
    reason: string;
    conversationId: string | null;
    createPhase: 'not-started' | 'creating' | 'reconcile-required' | 'created';
    createdCandidate?: { conversationId: string; canonicalPath: string; dev: string; ino: string; createdAt: number };
  } | undefined;
  replacementCandidates(projectId: string, projectRoot: string): unknown[];
  resume(input: { projectId: string; projectRoot: string; expectedGeneration: number }): Promise<unknown>;
  reconcile(input: { projectId: string; projectRoot: string; expectedGeneration: number; conversationId: string }): Promise<unknown>;
};
type ServiceInput = {
  projectId: string;
  projectRoot: string;
  provenanceDigest: string;
  idempotencyKey: string;
};
type Dependencies = {
  resolveOwnedProject(user: UserProfile, projectId: string): OwnedProject | undefined;
  hasPendingInteraction?: (projectId: string) => boolean;
};

const empty = z.object({}).strict();
const adopt = z.object({ conversationId: z.string().uuid() }).strict();
const recover = z.object({ expectedGeneration: z.number().int().positive() }).strict();
const replace = z.object({
  expectedGeneration: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const resume = z.object({ expectedGeneration: z.number().int().positive() }).strict();
const reconcile = z.object({ expectedGeneration: z.number().int().positive(), conversationId: z.string().uuid() }).strict();

export class ProjectHumanThreadController {
  readonly #service: Service;
  readonly #deps: Dependencies;

  constructor(service: Service, dependencies: Dependencies) {
    this.#service = service;
    this.#deps = dependencies;
  }

  read(user: UserProfile, projectId: string): {
    current: ProjectHumanThreadBinding | undefined;
    candidates: unknown[];
    replacement?: { expectedGeneration: number; reason: string; createPhase: 'not-started' | 'creating' | 'reconcile-required' | 'created'; createdConversationId?: string };
  } {
    const project = this.#owned(user, projectId);
    const current = this.#service.current(project.projectId);
    return {
      current,
      candidates: current?.status === 'replacement-pending'
        ? this.#service.replacementCandidates(project.projectId, project.root)
        : current ? [] : this.#service.candidates(project.root),
      replacement: current?.status === 'replacement-pending'
        ? redactReplacementIntent(this.#service.replacementIntent(project.projectId))
        : undefined,
    };
  }

  history(user: UserProfile, projectId: string): Array<Omit<ProjectHumanThreadBinding, 'root' | 'provenanceDigest'>> {
    const project = this.#owned(user, projectId);
    return this.#service.history(project.projectId).map(redactHistoryBinding);
  }

  async createMissing(user: UserProfile, projectId: string, idempotencyKey: string, payload: unknown): Promise<unknown> {
    parseBody(empty, payload);
    const project = this.#owned(user, projectId);
    return await this.#service.createMissing(this.#input(user, project, idempotencyKey, 'create'));
  }

  async adopt(user: UserProfile, projectId: string, idempotencyKey: string, payload: unknown): Promise<unknown> {
    const body = parseBody(adopt, payload);
    const project = this.#owned(user, projectId);
    return await this.#service.adopt({ ...this.#input(user, project, idempotencyKey, 'adopt'), ...body });
  }

  async recover(user: UserProfile, projectId: string, idempotencyKey: string, payload: unknown): Promise<unknown> {
    const body = parseBody(recover, payload);
    const project = this.#owned(user, projectId);
    return this.#service.recover(project.projectId, body.expectedGeneration, idempotencyKey);
  }

  async replace(user: UserProfile, projectId: string, idempotencyKey: string, payload: unknown): Promise<unknown> {
    const body = parseBody(replace, payload);
    const project = this.#owned(user, projectId);
    if (project.activeRun) throw new Error('Project human thread cannot be replaced during an active run.');
    if (this.#deps.hasPendingInteraction?.(project.projectId)) {
      throw new Error('Project human thread cannot be replaced while human interaction is pending.');
    }
    return await this.#service.replace({ ...this.#input(user, project, idempotencyKey, 'replace'), ...body });
  }

  async resume(user: UserProfile, projectId: string, payload: unknown): Promise<unknown> {
    const body = parseBody(resume, payload);
    const project = this.#owned(user, projectId);
    if (project.activeRun) throw new Error('Project human thread cannot be replaced during an active run.');
    return await this.#service.resume({ projectId: project.projectId, projectRoot: project.root, ...body });
  }

  async reconcile(user: UserProfile, projectId: string, payload: unknown): Promise<unknown> {
    const body = parseBody(reconcile, payload);
    const project = this.#owned(user, projectId);
    if (project.activeRun) throw new Error('Project human thread cannot be replaced during an active run.');
    return await this.#service.reconcile({ projectId: project.projectId, projectRoot: project.root, ...body });
  }

  #owned(user: UserProfile, projectId: string): OwnedProject {
    if (!user.roles.includes('user')) throw new Error('Project not found.');
    const project = this.#deps.resolveOwnedProject(user, projectId);
    if (!project || project.projectId !== projectId) throw new Error('Project not found.');
    return project;
  }

  #input(user: UserProfile, project: OwnedProject, idempotencyKey: string, action: string): ServiceInput {
    return {
      projectId: project.projectId,
      projectRoot: project.root,
      idempotencyKey,
      provenanceDigest: createHash('sha256')
        .update(JSON.stringify({ action, actor: user.id, idempotencyKey, projectId: project.projectId, root: project.root }))
        .digest('hex'),
    };
  }
}

function redactReplacementIntent(intent: ReturnType<Service['replacementIntent']>): {
  expectedGeneration: number;
  reason: string;
  createPhase: 'not-started' | 'creating' | 'reconcile-required' | 'created';
  createdConversationId?: string;
} | undefined {
  if (!intent) return undefined;
  return {
    expectedGeneration: intent.expectedGeneration,
    reason: intent.reason,
    createPhase: intent.createPhase,
    ...(intent.createdCandidate ? { createdConversationId: intent.createdCandidate.conversationId } : {}),
  };
}

function redactHistoryBinding(binding: ProjectHumanThreadBinding): Omit<ProjectHumanThreadBinding, 'root' | 'provenanceDigest'> {
  return {
    schemaVersion: binding.schemaVersion,
    bindingId: binding.bindingId,
    projectId: binding.projectId,
    purpose: binding.purpose,
    conversationId: binding.conversationId,
    generation: binding.generation,
    status: binding.status,
    predecessorGeneration: binding.predecessorGeneration,
    creationMode: binding.creationMode,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    retiredAt: binding.retiredAt,
    recordDigest: binding.recordDigest,
  };
}

function parseBody<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error('Project human thread request is invalid.');
  return parsed.data;
}
