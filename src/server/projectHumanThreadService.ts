import { bindingDigest, type ProjectHumanThreadBinding } from '../shared/projectHumanThreadContracts.js';
import { isProjectHumanThreadCreateNoSideEffect, type ProjectHumanThreadAuthority, type ProjectHumanThreadCandidate } from './projectHumanThreadAuthority.js';
import type { ProjectHumanThreadStore, ProjectRootIdentity } from './projectHumanThreadStore.js';

type Authority = Pick<ProjectHumanThreadAuthority, 'candidates' | 'adoptableCandidates' | 'inspect' | 'inspectAdoptable' | 'create' | 'bootstrap' | 'registerCreated' | 'repair' | 'prepareReplacement'> & {
  rootIdentity?: (projectRoot: string) => ProjectRootIdentity;
};
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
export type ReplacementResult =
  | { outcome: 'replaced' | 'current'; binding: ProjectHumanThreadBinding }
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

  currentForRoot(projectRoot: string): ProjectHumanThreadBinding | undefined {
    return this.#store.currentByRoot(this.#rootIdentity(projectRoot));
  }

  historyForRoot(projectRoot: string): ProjectHumanThreadBinding[] {
    const current = this.currentForRoot(projectRoot);
    return current ? this.#store.history(current.projectId) : [];
  }

  async createMissing(input: BaseRequest): Promise<CreateMissingResult> {
    requireBase(input);
    const prepared = this.#prepare(input);
    const current = this.#store.currentByRoot(prepared.root) ?? this.#store.current(input.projectId);
    if (current) {
      requireRoot(current, prepared.projectRoot);
      const intent = this.#store.creationIntent(current.projectId);
      if (intent?.state === 'prepared' && intent.eventId === input.idempotencyKey) {
        this.#store.completeCreationIntent(current.projectId, input.idempotencyKey, current.conversationId);
      }
      return { outcome: 'current', binding: current };
    }
    const priorIntent = this.#store.creationIntent(prepared.projectId);
    if (priorIntent?.state === 'prepared' && priorIntent.createPhase === 'created' && priorIntent.createdCandidate) {
      const candidate = await this.#authority.registerCreated(priorIntent.createdCandidate);
      const binding = createBinding(prepared, candidate, 1, null, 'created', this.#now());
      const result = this.#store.createInitial(binding, input.idempotencyKey);
      this.#store.completeCreationIntent(prepared.projectId, input.idempotencyKey, binding.conversationId);
      return { outcome: result.inserted ? 'created' : 'current', binding: result.binding };
    }
    if (priorIntent?.state === 'prepared' && priorIntent.createPhase !== 'not-started') {
      return { outcome: 'reconciliation-required', candidates: [] };
    }
    const candidates = this.#authority.adoptableCandidates(prepared.projectRoot);
    if (candidates.length > 0) return { outcome: 'adoption-required', candidates };
    const intent = this.#store.beginCreationIntent(prepared.projectId, input.idempotencyKey, {
      projectRoot: prepared.projectRoot, provenanceDigest: input.provenanceDigest,
    }, prepared.root);
    if (!intent.inserted && priorIntent?.createPhase !== 'not-started') {
      return { outcome: 'reconciliation-required', candidates: [] };
    }
    if (!this.#store.markCreationStarted(prepared.projectId, input.idempotencyKey)) {
      return { outcome: 'reconciliation-required', candidates: [] };
    }
    let candidate: ProjectHumanThreadCandidate;
    try {
      candidate = await this.#authority.bootstrap(prepared.projectRoot);
      this.#store.markCreationCreated(prepared.projectId, input.idempotencyKey, candidate);
      candidate = await this.#authority.registerCreated(candidate);
    } catch (error) {
      const phase = this.#store.creationIntent(prepared.projectId)?.createPhase;
      if (phase !== 'created') {
        if (isProjectHumanThreadCreateNoSideEffect(error)) this.#store.markCreationNoSideEffect(prepared.projectId, input.idempotencyKey);
        else this.#store.markCreationReconciliationRequired(prepared.projectId, input.idempotencyKey);
      }
      throw error;
    }
    const binding = createBinding(prepared, candidate, 1, null, 'created', this.#now());
    const result = this.#store.createInitial(binding, input.idempotencyKey);
    this.#store.completeCreationIntent(prepared.projectId, input.idempotencyKey, binding.conversationId);
    return { outcome: result.inserted ? 'created' : 'current', binding: result.binding };
  }

  async adopt(input: BaseRequest & { conversationId: string }): Promise<{ outcome: 'adopted' | 'current'; binding: ProjectHumanThreadBinding }> {
    requireBase(input);
    const prepared = this.#prepare(input);
    const current = this.#store.currentByRoot(prepared.root) ?? this.#store.current(input.projectId);
    if (current) {
      requireRoot(current, prepared.projectRoot);
      if (current.conversationId !== input.conversationId) throw new Error('Project already has a different human thread.');
      return { outcome: 'current', binding: current };
    }
    const candidate = this.#authority.inspectAdoptable(prepared.projectRoot, input.conversationId);
    const binding = createBinding(prepared, candidate, 1, null, 'adopted', this.#now());
    const result = this.#store.createInitial(binding, input.idempotencyKey);
    const intent = this.#store.creationIntent(input.projectId);
    if (intent?.state === 'prepared') {
      this.#store.completeCreationIntent(input.projectId, intent.eventId, binding.conversationId);
    }
    return { outcome: result.inserted ? 'adopted' : 'current', binding: result.binding };
  }

  recover(projectId: string, expectedGeneration: number, idempotencyKey: string, projectRoot?: string): { outcome: 'recovered' | 'unavailable' | 'replacement-pending'; binding: ProjectHumanThreadBinding } {
    requireIdentity(projectId, idempotencyKey);
    const root = projectRoot ? this.#rootIdentity(projectRoot, projectId) : undefined;
    const current = (root ? this.#store.currentByRoot(root) : undefined) ?? this.#store.current(projectId);
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
        ? this.#store.markRecovered(current.projectId, expectedGeneration, this.#now(), idempotencyKey)
        : current;
      return { outcome: 'recovered', binding };
    } catch {
      if (current.status === 'unavailable') return { outcome: 'unavailable', binding: current };
      const binding = this.#store.markUnavailable(
        current.projectId, expectedGeneration, 'Thread cannot be recovered', this.#now(), idempotencyKey,
      );
      return { outcome: 'unavailable', binding };
    }
  }

  replacementIntent(projectId: string) {
    return this.#store.replacementIntent(projectId);
  }

  replacementCandidates(projectId: string, projectRoot: string): ProjectHumanThreadCandidate[] {
    const current = this.#store.current(projectId);
    if (!current || current.status !== 'replacement-pending') return [];
    const boundIds = new Set(this.#store.history(projectId).map((item) => item.conversationId));
    return this.#authority.adoptableCandidates(projectRoot).filter((item) => !boundIds.has(item.conversationId));
  }

  async resume(input: { projectId: string; projectRoot: string; expectedGeneration: number }): Promise<ReplacementResult> {
    const root = this.#rootIdentity(input.projectRoot, input.projectId);
    const current = this.#store.currentByRoot(root);
    const projectId = current?.projectId ?? input.projectId;
    const intent = this.#store.replacementIntent(projectId);
    if (!intent || intent.state !== 'prepared') throw new Error('Project human thread replacement intent is unavailable.');
    if (intent.expectedGeneration !== input.expectedGeneration || intent.projectRoot !== root.canonicalPath) {
      throw new Error('Project human thread replacement intent conflict.');
    }
    return this.replace({
      projectId,
      projectRoot: root.canonicalPath,
      provenanceDigest: intent.provenanceDigest,
      idempotencyKey: intent.idempotencyKey,
      expectedGeneration: intent.expectedGeneration,
      reason: intent.reason,
    });
  }

  async reconcile(input: {
    projectId: string;
    projectRoot: string;
    expectedGeneration: number;
    conversationId: string;
  }): Promise<ReplacementResult> {
    const root = this.#rootIdentity(input.projectRoot, input.projectId);
    const current = this.#store.currentByRoot(root) ?? this.#store.current(input.projectId);
    const projectId = current?.projectId ?? input.projectId;
    const intent = this.#store.replacementIntent(projectId);
    if (!current || current.status !== 'replacement-pending' || (intent && intent.state !== 'prepared')) {
      throw new Error('Project human thread replacement reconciliation is unavailable.');
    }
    if (current.generation !== input.expectedGeneration
      || (intent && (intent.expectedGeneration !== input.expectedGeneration || intent.projectRoot !== root.canonicalPath))) {
      throw new Error('Project human thread replacement intent conflict.');
    }
    const boundIds = new Set(this.#store.history(projectId).map((item) => item.conversationId));
    if (boundIds.has(input.conversationId)) throw new Error('Project human thread replacement candidate is already bound.');
    const candidate = this.#authority.inspectAdoptable(root.canonicalPath, input.conversationId);
    const reconciliationKey = intent?.idempotencyKey ?? `legacy-reconcile:${projectId}:${input.expectedGeneration}`;
    const next = createBinding(
      {
        projectId,
        projectRoot: root.canonicalPath,
        provenanceDigest: intent?.provenanceDigest ?? current.provenanceDigest,
        idempotencyKey: reconciliationKey,
      }, candidate, input.expectedGeneration + 1, input.expectedGeneration, 'adopted',
      laterTimestamp(this.#now(), current.updatedAt),
    );
    const result = this.#store.activateReplacement(next, input.expectedGeneration, `${reconciliationKey}:activate`);
    if (intent) this.#store.completeReplacementIntent(projectId, intent.eventId, result.binding.conversationId);
    return { outcome: result.inserted ? 'replaced' : 'current', binding: result.binding };
  }

  async replace(input: BaseRequest & { expectedGeneration: number; reason: string }): Promise<ReplacementResult> {
    requireBase(input);
    if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1
      || !input.reason || input.reason !== input.reason.trim() || input.reason.length > 1_000) {
      throw new Error('Project human thread replacement request is invalid.');
    }
    const prepared = this.#prepare(input);
    const operation = { ...input, projectId: prepared.projectId, projectRoot: prepared.projectRoot };
    const current = this.#store.currentByRoot(prepared.root) ?? this.#store.current(input.projectId);
    if (current?.generation === input.expectedGeneration + 1
      && current.predecessorGeneration === input.expectedGeneration
      && current.provenanceDigest === input.provenanceDigest) {
      const intent = this.#store.replacementIntent(operation.projectId);
      if (intent && !sameReplacementIntent(intent, operation)) {
        throw new Error('Project human thread replacement intent conflict.');
      }
      if (intent?.state === 'prepared') {
        // Activation and intent completion are separate durable writes. A
        // restart between them must reconcile the intent to the already
        // authoritative binding before returning the idempotent result.
        this.#store.completeReplacementIntent(operation.projectId, intent.eventId, current.conversationId);
      }
      return { outcome: 'current', binding: current };
    }
    const beginEventId = `${input.idempotencyKey}:begin`;
    const intent = {
      idempotencyKey: input.idempotencyKey,
      expectedGeneration: input.expectedGeneration,
      projectRoot: operation.projectRoot,
      provenanceDigest: input.provenanceDigest,
      reason: input.reason,
    };
    const existingIntent = this.#store.replacementIntent(operation.projectId);
    let pending: ProjectHumanThreadBinding;
    if (current?.status === 'replacement-pending') {
      // Only the exact operation that created the pending transition may
      // resume it. A new idempotency key or changed provenance is fail-closed.
      if (!existingIntent || existingIntent.state !== 'prepared' || !sameReplacementIntent(existingIntent, operation)) {
        throw new Error('Project human thread replacement intent conflict.');
      }
      pending = current;
    } else {
      pending = this.#store.beginReplacement(
        operation.projectId, input.expectedGeneration, input.reason, this.#now(), beginEventId, intent, prepared.root,
      );
    }
    requireRoot(pending, operation.projectRoot);
    // The pending intent is durable before the predecessor handoff. The
    // authority must make the old locator inert and prove its writer absent
    // before any successor bootstrap can begin. Replays are idempotent.
    this.#authority.prepareReplacement(pending);
    const boundIds = new Set(this.#store.history(operation.projectId).map((item) => item.conversationId));
    const candidates = this.#authority.adoptableCandidates(operation.projectRoot).filter((item) => !boundIds.has(item.conversationId));
    const activeIntent = this.#store.replacementIntent(operation.projectId);
    const replacementPhase = activeIntent?.createPhase ?? 'not-started';
    // Candidates discovered before this exact operation durably recorded a
    // returned identity are never auto-adopted. Same-directory Codex threads
    // include internal development workers and require explicit provenance
    // and quiescence reconciliation.
    if (candidates.length > 0 && replacementPhase !== 'created') {
      return { outcome: 'reconciliation-required', candidates };
    }
    let candidate: ProjectHumanThreadCandidate;
    let creationMode: ProjectHumanThreadBinding['creationMode'];
    if (replacementPhase === 'created' && activeIntent?.createdCandidate) {
      try {
        const persisted = this.#authority.inspect(operation.projectRoot, activeIntent.createdCandidate.conversationId);
        if (boundIds.has(persisted.conversationId)) throw new Error('candidate is already bound');
        candidate = await this.#authority.registerCreated(persisted);
        creationMode = 'created';
      } catch {
        // A persisted operation identity without an inspectable candidate is
        // reconciled explicitly; it is never converted into another create.
        return { outcome: 'reconciliation-required', candidates: [] };
      }
    } else if (replacementPhase !== 'not-started') {
      return { outcome: 'reconciliation-required', candidates: [] };
    } else {
      if (!this.#store.markReplacementCreateStarted(operation.projectId, beginEventId)) {
        return { outcome: 'reconciliation-required', candidates: [] };
      }
      try {
        candidate = await this.#authority.bootstrap(operation.projectRoot);
        // A returned candidate is the durable operation identity. Persist it
        // before activation so a restart can inspect/adopt it without create.
        this.#store.markReplacementCreated(operation.projectId, beginEventId, candidate);
        candidate = await this.#authority.registerCreated(candidate);
      } catch (error) {
        const phase = this.#store.replacementIntent(operation.projectId)?.createPhase;
        if (phase !== 'created') {
          if (isProjectHumanThreadCreateNoSideEffect(error)) this.#store.markReplacementCreateNoSideEffect(operation.projectId, beginEventId);
          else this.#store.markReplacementCreateReconciliationRequired(operation.projectId, beginEventId);
        }
        throw error;
      }
      creationMode = 'created';
    }
    const next = createBinding(
      operation, candidate, input.expectedGeneration + 1, input.expectedGeneration,
      creationMode, laterTimestamp(this.#now(), pending.updatedAt),
    );
    const result = this.#store.activateReplacement(next, input.expectedGeneration, `${input.idempotencyKey}:activate`);
    this.#store.completeReplacementIntent(operation.projectId, beginEventId, result.binding.conversationId);
    return { outcome: result.inserted ? 'replaced' : 'current', binding: result.binding };
  }

  current(projectId: string): ProjectHumanThreadBinding | undefined { return this.#store.current(projectId); }
  history(projectId: string): ProjectHumanThreadBinding[] { return this.#store.history(projectId); }
  isBoundConversation(conversationId: string): boolean { return this.#store.isBoundConversation(conversationId); }
  candidates(projectRoot: string): ProjectHumanThreadCandidate[] { return this.#authority.adoptableCandidates(projectRoot); }

  #prepare(input: BaseRequest): BaseRequest & { root: ProjectRootIdentity } {
    const root = this.#rootIdentity(input.projectRoot, input.projectId);
    const current = this.#store.currentByRoot(root);
    return {
      ...input,
      projectId: current?.projectId ?? input.projectId,
      projectRoot: root.canonicalPath,
      root,
    };
  }

  #rootIdentity(projectRoot: string, projectId?: string): ProjectRootIdentity {
    const known = projectId ? this.#store.current(projectId) : undefined;
    return this.#authority.rootIdentity?.(projectRoot)
      ?? (known && known.root.canonicalPath === projectRoot ? known.root : undefined)
      ?? this.#authority.candidates(projectRoot)[0]
      ?? { canonicalPath: projectRoot, dev: '0', ino: '1' };
  }
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
