import { bindingDigest, type ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';
import type { ProjectHumanThreadAuthority, ProjectHumanThreadCandidate } from './projectHumanThreadAuthority.js';
import type { ProjectHumanThreadStore } from './projectHumanThreadStore.js';

type Authority = Pick<ProjectHumanThreadAuthority, 'candidates' | 'inspect' | 'create' | 'repair'>;
type ServiceOptions = { now?: () => string };
type BaseRequest = {
  projectId: string;
  projectRoot: string;
  provenanceDigest: string;
  idempotencyKey: string;
};

export type CreateMissingResult =
  | { outcome: 'created' | 'current'; binding: ProjectHumanThreadBinding }
  | { outcome: 'adoption-required'; candidates: ProjectHumanThreadCandidate[] }
  | { outcome: 'reconciliation-required'; candidates: ProjectHumanThreadCandidate[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export class ProjectHumanThreadService {
  readonly #store: ProjectHumanThreadStore;
  readonly #authority: Authority;
  readonly #now: () => string;

  constructor(store: ProjectHumanThreadStore, authority: Authority, options: ServiceOptions = {}) {
    this.#store = store;
    this.#authority = authority;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async createMissing(input: BaseRequest): Promise<CreateMissingResult> {
    requireBase(input);
    const current = this.#store.current(input.projectId);
    if (current) {
      requireRoot(current, input.projectRoot);
      const intent = this.#store.creationIntent(input.projectId);
      if (intent?.state === 'prepared' && intent.eventId === input.idempotencyKey) {
        this.#store.completeCreationIntent(input.projectId, input.idempotencyKey, current.conversationId);
      }
      return { outcome: 'current', binding: current };
    }
    const candidates = this.#authority.candidates(input.projectRoot);
    if (candidates.length > 0) return { outcome: 'adoption-required', candidates };
    const intent = this.#store.beginCreationIntent(input.projectId, input.idempotencyKey, {
      projectRoot: input.projectRoot, provenanceDigest: input.provenanceDigest,
    });
    if (!intent.inserted) return { outcome: 'reconciliation-required', candidates: [] };
    const candidate = await this.#authority.create(input.projectRoot);
    const binding = createBinding(input, candidate, 1, null, 'created', this.#now());
    const result = this.#store.createInitial(binding, input.idempotencyKey);
    this.#store.completeCreationIntent(input.projectId, input.idempotencyKey, binding.conversationId);
    return { outcome: result.inserted ? 'created' : 'current', binding: result.binding };
  }

  async adopt(input: BaseRequest & { conversationId: string }): Promise<{ outcome: 'adopted' | 'current'; binding: ProjectHumanThreadBinding }> {
    requireBase(input);
    const current = this.#store.current(input.projectId);
    if (current) {
      requireRoot(current, input.projectRoot);
      if (current.conversationId !== input.conversationId) throw new Error('Project already has a different human thread.');
      return { outcome: 'current', binding: current };
    }
    const candidate = this.#authority.inspect(input.projectRoot, input.conversationId);
    const binding = createBinding(input, candidate, 1, null, 'adopted', this.#now());
    const result = this.#store.createInitial(binding, input.idempotencyKey);
    const intent = this.#store.creationIntent(input.projectId);
    if (intent?.state === 'prepared') {
      this.#store.completeCreationIntent(input.projectId, intent.eventId, binding.conversationId);
    }
    return { outcome: result.inserted ? 'adopted' : 'current', binding: result.binding };
  }

  recover(projectId: string, expectedGeneration: number, idempotencyKey: string): { outcome: 'recovered' | 'unavailable' | 'replacement-pending'; binding: ProjectHumanThreadBinding } {
    requireIdentity(projectId, idempotencyKey);
    const current = this.#store.current(projectId);
    if (!current || current.generation !== expectedGeneration) throw new Error('Project human thread generation conflict.');
    // A replacement transition is deliberately not convertible to
    // unavailable: the durable replacement intent owns the recovery path.
    // The caller must retry that exact request so an external create can be
    // adopted or resumed without inventing a second operation.
    if (current.status === 'replacement-pending') return { outcome: 'replacement-pending', binding: current };
    try {
      const candidate = this.#authority.inspect(current.root.canonicalPath, current.conversationId);
      if (candidate.dev !== current.root.dev || candidate.ino !== current.root.ino) throw new Error('root identity changed');
      this.#authority.repair(current);
      const binding = current.status === 'unavailable'
        ? this.#store.markRecovered(projectId, expectedGeneration, this.#now(), idempotencyKey)
        : current;
      return { outcome: 'recovered', binding };
    } catch {
      if (current.status === 'unavailable') return { outcome: 'unavailable', binding: current };
      const binding = this.#store.markUnavailable(
        projectId, expectedGeneration, 'Thread cannot be recovered', this.#now(), idempotencyKey,
      );
      return { outcome: 'unavailable', binding };
    }
  }

  async replace(input: BaseRequest & { expectedGeneration: number; reason: string }): Promise<{ outcome: 'replaced' | 'current'; binding: ProjectHumanThreadBinding }> {
    requireBase(input);
    if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1
      || !input.reason || input.reason !== input.reason.trim() || input.reason.length > 1_000) {
      throw new Error('Project human thread replacement request is invalid.');
    }
    const current = this.#store.current(input.projectId);
    if (current?.generation === input.expectedGeneration + 1
      && current.predecessorGeneration === input.expectedGeneration
      && current.provenanceDigest === input.provenanceDigest) {
      const intent = this.#store.replacementIntent(input.projectId);
      if (intent && !sameReplacementIntent(intent, input)) {
        throw new Error('Project human thread replacement intent conflict.');
      }
      if (intent?.state === 'prepared') {
        // Activation and intent completion are separate durable writes. A
        // restart between them must reconcile the intent to the already
        // authoritative binding before returning the idempotent result.
        this.#store.completeReplacementIntent(input.projectId, intent.eventId, current.conversationId);
      }
      return { outcome: 'current', binding: current };
    }
    const beginEventId = `${input.idempotencyKey}:begin`;
    const intent = {
      idempotencyKey: input.idempotencyKey,
      expectedGeneration: input.expectedGeneration,
      projectRoot: input.projectRoot,
      provenanceDigest: input.provenanceDigest,
      reason: input.reason,
    };
    const existingIntent = this.#store.replacementIntent(input.projectId);
    let pending: ProjectHumanThreadBinding;
    if (current?.status === 'replacement-pending') {
      // Only the exact operation that created the pending transition may
      // resume it. A new idempotency key or changed provenance is fail-closed.
      if (!existingIntent || existingIntent.state !== 'prepared' || !sameReplacementIntent(existingIntent, input)) {
        throw new Error('Project human thread replacement intent conflict.');
      }
      pending = current;
    } else {
      pending = this.#store.beginReplacement(
        input.projectId, input.expectedGeneration, input.reason, this.#now(), beginEventId, intent,
      );
    }
    requireRoot(pending, input.projectRoot);
    const boundIds = new Set(this.#store.history(input.projectId).map((item) => item.conversationId));
    const candidates = this.#authority.candidates(input.projectRoot).filter((item) => !boundIds.has(item.conversationId));
    if (candidates.length > 1) throw new Error('Project human thread replacement candidates are ambiguous.');
    const candidate = candidates[0] ?? await this.#authority.create(input.projectRoot);
    const next = createBinding(
      input, candidate, input.expectedGeneration + 1, input.expectedGeneration,
      candidates[0] ? 'adopted' : 'created', laterTimestamp(this.#now(), pending.updatedAt),
    );
    const result = this.#store.activateReplacement(next, input.expectedGeneration, `${input.idempotencyKey}:activate`);
    this.#store.completeReplacementIntent(input.projectId, beginEventId, result.binding.conversationId);
    return { outcome: result.inserted ? 'replaced' : 'current', binding: result.binding };
  }

  current(projectId: string): ProjectHumanThreadBinding | undefined { return this.#store.current(projectId); }
  history(projectId: string): ProjectHumanThreadBinding[] { return this.#store.history(projectId); }
  candidates(projectRoot: string): ProjectHumanThreadCandidate[] { return this.#authority.candidates(projectRoot); }
}

function createBinding(
  input: BaseRequest,
  candidate: ProjectHumanThreadCandidate,
  generation: number,
  predecessorGeneration: number | null,
  creationMode: ProjectHumanThreadBinding['creationMode'],
  occurredAt: string,
): ProjectHumanThreadBinding {
  if (candidate.canonicalPath !== input.projectRoot) throw new Error('Candidate does not bind the requested project root.');
  const value = {
    schemaVersion: 'roadex.project-human-thread-binding.v1' as const,
    bindingId: `project-human-thread:${input.projectId}:${generation}`,
    projectId: input.projectId,
    root: { canonicalPath: candidate.canonicalPath, dev: candidate.dev, ino: candidate.ino },
    purpose: 'human-interaction' as const,
    conversationId: candidate.conversationId,
    generation,
    status: 'active' as const,
    predecessorGeneration,
    creationMode,
    provenanceDigest: input.provenanceDigest,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    retiredAt: null,
  };
  return { ...value, recordDigest: bindingDigest(value) };
}

function requireBase(input: BaseRequest): void {
  requireIdentity(input.projectId, input.idempotencyKey);
  if (!input.projectRoot.startsWith('/') || input.projectRoot !== input.projectRoot.trim() || !DIGEST.test(input.provenanceDigest)) {
    throw new Error('Project human thread request is invalid.');
  }
}
function requireIdentity(projectId: string, idempotencyKey: string): void {
  if (!ID.test(projectId) || !ID.test(idempotencyKey)) throw new Error('Project human thread request identity is invalid.');
}
function requireRoot(binding: ProjectHumanThreadBinding, projectRoot: string): void {
  if (binding.root.canonicalPath !== projectRoot) throw new Error('Project human thread root conflict.');
}
function sameReplacementIntent(
  intent: { idempotencyKey: string; expectedGeneration: number; projectRoot: string; provenanceDigest: string; reason: string },
  input: BaseRequest & { expectedGeneration: number; reason: string },
): boolean {
  return intent.idempotencyKey === input.idempotencyKey
    && intent.expectedGeneration === input.expectedGeneration
    && intent.projectRoot === input.projectRoot
    && intent.provenanceDigest === input.provenanceDigest
    && intent.reason === input.reason;
}
function laterTimestamp(candidate: string, prior: string): string {
  const candidateTime = Date.parse(candidate);
  const priorTime = Date.parse(prior);
  if (Number.isNaN(candidateTime) || Number.isNaN(priorTime)) throw new Error('Project human thread timestamp is invalid.');
  return new Date(Math.max(candidateTime, priorTime + 1)).toISOString();
}
