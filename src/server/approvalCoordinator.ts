import { createHash, randomBytes } from 'node:crypto';
import type { AuditEvent, RoadexSession } from '../shared/sessionContracts.js';
import {
  type ApprovalWaitRecord,
  type ApprovalWaitState,
  type NormalizedApprovalStatus,
  type ApprovalConsoleSurface,
  type WaitingApprovalSummary,
  consoleForAuthority,
} from '../shared/approvalWorkflowContracts.js';
import type { ApprovalStatusProvider } from './approvalStatusProvider.js';
import { buildApprovalContinuation } from './approvalContinuation.js';

export type ApprovalSessionCapability = {
  sessionId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  managedThreadId: string;
  runnerRunId?: string;
};

export type RegisterApprovalWaitInput = {
  provider: 'overseer';
  approvalRef: string;
};

export type RegisterApprovalWaitResult =
  | {
      ok: true;
      wait: WaitingApprovalSummary;
    }
  | {
      ok: false;
      code: 'active-wait-exists' | 'approval-not-pending' | 'provider-unavailable' | 'scope-mismatch';
    };

export type ApprovalContinuationDispatchResult =
  | { status: 'started'; runnerRunId: string }
  | { status: 'capacity'; retryAt: string }
  | { status: 'ambiguous' }
  | { status: 'denied'; reason: 'session-closed' | 'thread-mismatch' | 'scope-mismatch' };

export type ApprovalRunnerCompletionResult =
  | { status: 'succeeded'; managedThreadId: string }
  | { status: 'failed' };

export type ReopenApprovalWaitResult = 'ready' | 'waiting' | 'denied';
export type ApprovalUserRunFailure = 'security-failure' | 'reconciliation-required';

export type ApprovalCoordinatorStateClock = {
  now: () => string;
};

export type ApprovalCoordinatorCallbacks = {
  persist: () => void | Promise<void>;
  publish: (sessionId: string, message: string) => void;
  audit: (action: AuditEvent['action'], outcome: AuditEvent['outcome'], summary: string, resource: string) => void;
  queueContinuation: (wait: ApprovalWaitRecord, prompt: string) => Promise<ApprovalContinuationDispatchResult>;
};

type ApprovalCoordinatorOptions = {
  clock?: ApprovalCoordinatorStateClock;
  idSource?: { generateWaitId: () => string };
  backoffJitter?: (attempt: number) => number;
  authorizeStreamingRegistration?: (
    session: RoadexSession,
    capability: ApprovalSessionCapability,
  ) => boolean;
};

type PublicWaitState = WaitingApprovalSummary['state'];

type SessionSnapshot = { lifecycle: RoadexSession['lifecycle']; waitingApproval?: WaitingApprovalSummary };

type DispatchAcknowledgement = {
  persisted: Promise<void>;
  release: () => void;
};

const WAIT_BASE_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_FIELD_LENGTH = 256;
const MAX_WAIT_ID_LENGTH = 64;
const MAX_WAIT_ID_GENERATION_ATTEMPTS = 8;
const MAX_RUNNER_RUN_ID_LENGTH = 64;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RETRY_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const PUBLISHED_WAIT_STATES = new Set<PublicWaitState>([
  'pending',
  'verification-delayed',
  'security-failure',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
]);

const WAIT_STATES_BLOCKING = new Set<ApprovalWaitState>([
  'pending',
  'verification-delayed',
  'security-failure',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
]);

const WAIT_DUE_STATES = new Set<ApprovalWaitState>([
  'pending',
  'verification-delayed',
  'approved-resume-queued',
  'resume-dispatching',
]);

const NON_APPROVED_DECISIONS = new Set<NormalizedApprovalStatus['decision']>([
  'changes-requested',
  'rejected',
  'expired',
  'revoked',
]);

function deterministicWaitId(): string {
  return `wait-${randomBytes(16).toString('hex')}`;
}

export class ApprovalCoordinator {
  readonly #waits: ApprovalWaitRecord[];
  readonly #sessions: RoadexSession[];
  readonly #provider: ApprovalStatusProvider;
  readonly #callbacks: ApprovalCoordinatorCallbacks;
  readonly #clock: ApprovalCoordinatorStateClock;
  readonly #idSource: { generateWaitId: () => string };
  readonly #backoffJitter: (attempt: number) => number;
  readonly #authorizeStreamingRegistration?: ApprovalCoordinatorOptions['authorizeStreamingRegistration'];
  readonly #sessionGeneration: Map<string, number>;
  readonly #sessionLocks: Map<string, Promise<unknown>>;
  readonly #dispatchAcknowledgements: Map<string, DispatchAcknowledgement>;
  readonly #completionPersistenceFailures: Set<string>;
  readonly #waitIdReservations: Set<string>;
  readonly #closedSessionRetirements: ApprovalWaitRecord[];
  #waitIdReservationLock = Promise.resolve();

  #tickInProgress = false;

  constructor(
    waits: ApprovalWaitRecord[],
    sessions: RoadexSession[],
    provider: ApprovalStatusProvider,
    callbacks: ApprovalCoordinatorCallbacks,
    options: ApprovalCoordinatorOptions = {},
  ) {
    this.#waits = waits;
    this.#sessions = sessions;
    this.#provider = provider;
    this.#callbacks = callbacks;
    this.#clock = options.clock ?? { now: () => new Date().toISOString() };
    this.#idSource = options.idSource ?? { generateWaitId: deterministicWaitId };
    this.#backoffJitter = options.backoffJitter ?? (() => 0);
    this.#authorizeStreamingRegistration = options.authorizeStreamingRegistration;
    this.#sessionGeneration = new Map();
    this.#sessionLocks = new Map();
    this.#dispatchAcknowledgements = new Map();
    this.#completionPersistenceFailures = new Set();
    this.#waitIdReservations = new Set();
    this.#closedSessionRetirements = [];

    const retiredAt = this.#clock.now();
    this.#sessions
      .filter((session) => session.lifecycle === 'closed')
      .forEach((session) => {
        this.#waits
          .filter((wait) => wait.sessionId === session.id && WAIT_STATES_BLOCKING.has(wait.state))
          .forEach((wait) => {
            wait.state = 'session-closed';
            wait.updatedAt = retiredAt;
            wait.nextCheckAt = retiredAt;
            delete wait.dispatchReservedAt;
            delete wait.runnerRunId;
            this.#closedSessionRetirements.push(wait);
          });
      });

    this.#sessions.forEach((session) => {
      this.projectSessionForWait(session);
    });
  }

  async #withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.#sessionLocks.set(sessionId, current.then(() => undefined, () => undefined));
    return current;
  }

  async #withGlobalWaitIdReservation<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#waitIdReservationLock;
    const current = previous.catch(() => undefined).then(work);
    this.#waitIdReservationLock = current.then(() => undefined, () => undefined);
    return current;
  }

  #releaseWaitIdReservation(waitId: string): void {
    this.#waitIdReservations.delete(waitId);
  }

  #sessionBindingMatchesCapability(session: RoadexSession, capability: ApprovalSessionCapability): boolean {
    return (
      session.userId === capability.userId
      && session.workspace.id === capability.workspaceId
      && session.managedThreadId === capability.managedThreadId
      && !!session.managedThreadId
      && session.codexThreadId === capability.managedThreadId
    );
  }

  #isAllowedLifecycleForRegistration(
    session: RoadexSession,
    capability: ApprovalSessionCapability,
  ): boolean {
    if (isAllowedLifecycleForRegistration(session.lifecycle)) {
      return true;
    }
    if (
      session.lifecycle !== 'streaming'
      || !capability.runnerRunId
      || !this.#isOpaqueToken(capability.runnerRunId, MAX_RUNNER_RUN_ID_LENGTH)
      || !this.#authorizeStreamingRegistration
    ) {
      return false;
    }
    try {
      return this.#authorizeStreamingRegistration(session, capability) === true;
    } catch {
      return false;
    }
  }

  #isDispatchEvidenceCanonical(wait: ApprovalWaitRecord, session: RoadexSession): boolean {
    if (!this.#isFieldValid(wait.sessionId)
      || !this.#isFieldValid(wait.userId)
      || !this.#isFieldValid(wait.projectId)
      || !this.#isFieldValid(wait.workspaceId)
      || !this.#isFieldValid(wait.resourceRef)
      || !this.#isFieldValid(wait.subject)
      || !this.#isFieldValid(wait.approvalRef)
      || !this.#isFieldValid(wait.managedThreadId)
      || !this.#isFieldValid(wait.continuationId)
      || !SHA256_PATTERN.test(wait.decisionVersion)
    ) {
      return false;
    }

    if (wait.authorityClass !== 'privileged-operation' && wait.authorityClass !== 'project-workflow') {
      return false;
    }

    if (wait.provider !== 'overseer' || !session || session.userId !== wait.userId || session.workspace.id !== wait.workspaceId) {
      return false;
    }

    try {
      if (wait.consoleSurface !== consoleForAuthority(wait.authorityClass)) {
        return false;
      }
    } catch {
      return false;
    }

    if (session.codexThreadId !== wait.managedThreadId || !session.managedThreadId || session.codexThreadId !== session.managedThreadId) {
      return false;
    }

    if (session.lifecycle !== 'paused') {
      return false;
    }

    if (!this.#isCanonicalWaitingSummary(wait, session.waitingApproval)) {
      return false;
    }

    const expectedContinuationId = Object.hasOwn(wait, 'successorOfWaitId')
      ? this.#canonicalSuccessorContinuationId(wait)
      : deriveContinuationId(wait.sessionId, wait.approvalRef, wait.decisionVersion);
    if (expectedContinuationId !== wait.continuationId) {
      return false;
    }

    return true;
  }

  #canonicalSuccessorContinuationId(wait: ApprovalWaitRecord): string | undefined {
    if (!wait.successorOfWaitId
      || !this.#isOpaqueToken(wait.id)
      || !this.#isOpaqueToken(wait.successorOfWaitId)
    ) {
      return undefined;
    }
    const predecessor = this.#waits.find((entry) => entry.id === wait.successorOfWaitId);
    if (!predecessor
      || predecessor === wait
      || predecessor.state !== 'session-closed'
      || predecessor.sessionId !== wait.sessionId
      || predecessor.userId !== wait.userId
      || predecessor.projectId !== wait.projectId
      || predecessor.workspaceId !== wait.workspaceId
      || predecessor.managedThreadId !== wait.managedThreadId
      || predecessor.provider !== wait.provider
      || predecessor.approvalRef !== wait.approvalRef
      || predecessor.resourceRef !== wait.resourceRef
      || predecessor.authorityClass !== wait.authorityClass
      || predecessor.consoleSurface !== wait.consoleSurface
    ) {
      return undefined;
    }
    return deriveSuccessorContinuationId(
      wait.id,
      wait.sessionId,
      wait.approvalRef,
      wait.decisionVersion,
    );
  }

  #isCanonicalWaitingSummary(
    wait: ApprovalWaitRecord,
    waiting: WaitingApprovalSummary | undefined,
  ): boolean {
    if (!waiting) {
      return false;
    }

    const expected = this.toPublic(wait);
    const expectedKeys = Object.keys(expected);

    if (!this.#isExactObject(waiting, expectedKeys)) {
      return false;
    }

    for (const key of Object.keys(expected)) {
      if (waiting[key as keyof WaitingApprovalSummary] !== expected[key as keyof WaitingApprovalSummary]) {
        return false;
      }
    }

    return true;
  }

  #hasActiveWait(sessionId: string): boolean {
    return this.hasActiveWait(sessionId);
  }

  async register(capability: ApprovalSessionCapability, input: RegisterApprovalWaitInput): Promise<RegisterApprovalWaitResult> {
    if (!this.#isExactObject(input, ['provider', 'approvalRef'])) {
      return { ok: false, code: 'scope-mismatch' };
    }

    if (input.provider !== 'overseer') {
      return { ok: false, code: 'scope-mismatch' };
    }

    if (
      !this.#isFieldValid(capability.sessionId)
      || !this.#isFieldValid(capability.userId)
      || !this.#isFieldValid(capability.projectId)
      || !this.#isFieldValid(capability.workspaceId)
      || !this.#isFieldValid(capability.resourceRef)
      || !this.#isFieldValid(capability.managedThreadId)
      || !this.#isFieldValid(input.approvalRef)
    ) {
      return { ok: false, code: 'scope-mismatch' };
    }

    const snapshotSessionId = capability.sessionId;

    let status: NormalizedApprovalStatus;
    try {
      status = await this.#provider.getStatus(input.approvalRef, {
        projectId: capability.projectId,
        workspaceId: capability.workspaceId,
        resourceRef: capability.resourceRef,
      });
    } catch {
      return { ok: false, code: 'provider-unavailable' };
    }

    if (
      status.provider !== 'overseer'
      || status.approvalRef !== input.approvalRef
      || status.projectId !== capability.projectId
      || status.workspaceId !== capability.workspaceId
      || status.resourceRef !== capability.resourceRef
      || status.decision !== 'pending'
      || status.authorityClass !== 'privileged-operation'
      && status.authorityClass !== 'project-workflow'
      || !this.#isFieldValid(status.approvalRef)
      || !this.#isFieldValid(status.projectId)
      || !this.#isFieldValid(status.workspaceId)
      || !this.#isFieldValid(status.resourceRef)
      || !this.#isFieldValid(status.subject)
      || !SHA256_PATTERN.test(status.decisionVersion)
    ) {
      return status.decision === 'pending'
        ? { ok: false, code: 'scope-mismatch' }
        : { ok: false, code: 'approval-not-pending' };
    }

    let consoleSurface: ApprovalConsoleSurface;
    try {
      consoleSurface = consoleForAuthority(status.authorityClass);
    } catch {
      return { ok: false, code: 'scope-mismatch' };
    }

    let waitId: string;
    try {
      waitId = await this.#withGlobalWaitIdReservation(async () => {
        const reservedId = this.#nextWaitId();
        this.#waitIdReservations.add(reservedId);
        return reservedId;
      });
    } catch {
      return { ok: false, code: 'scope-mismatch' };
    }

    try {
      return await this.#withSessionLock(snapshotSessionId, async () => {
        const session = this.#sessions.find((entry) => entry.id === snapshotSessionId);
        if (
          !session
          || !this.#isFieldValid(capability.sessionId)
          || !this.#isAllowedLifecycleForRegistration(session, capability)
          || !this.#sessionBindingMatchesCapability(session, capability)
        ) {
          return { ok: false, code: 'scope-mismatch' } as const;
        }

        if (!session.managedThreadId) {
          return { ok: false, code: 'scope-mismatch' } as const;
        }

        const managedThreadId = session.managedThreadId;

        if (this.#hasActiveWait(session.id)) {
          return { ok: false, code: 'active-wait-exists' } as const;
        }

        const now = this.#clock.now();
        const record: ApprovalWaitRecord = {
          id: waitId,
          sessionId: session.id,
          userId: session.userId,
          projectId: status.projectId,
          workspaceId: status.workspaceId,
          managedThreadId,
          provider: 'overseer',
          approvalRef: status.approvalRef,
          resourceRef: status.resourceRef,
          authorityClass: status.authorityClass,
          consoleSurface,
          subject: status.subject,
          state: 'pending',
          decisionVersion: status.decisionVersion,
          continuationId: deriveContinuationId(session.id, status.approvalRef, status.decisionVersion),
          checkAttempt: 0,
          nextCheckAt: this.nextCheckAt(now, 1),
          createdAt: now,
          updatedAt: now,
        };

        const sessionBefore = this.snapshotSession(session);
        const waitBefore = this.snapshotWait(record);

        this.#waits.push(record);
        this.projectSessionForWait(session);

        const persisted = await this.#persistWaitTransition(
          session,
          sessionBefore,
          record,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
          () => {
            this.#publish(session.id, this.#waitingCopy(record));
            this.#audit('approval_wait.register', 'allowed', this.#auditSummary(record), record.sessionId);
          },
        );
        if (!persisted) {
          const inserted = this.#waits.indexOf(record);
          if (inserted >= 0) {
            this.#waits.splice(inserted, 1);
          }
          return { ok: false, code: 'provider-unavailable' } as const;
        }

        return {
          ok: true,
          wait: {
            waitId: record.id,
            state: 'pending',
            consoleSurface: record.consoleSurface,
            consolePath: undefined,
            approvalRef: record.approvalRef,
            subject: record.subject,
            updatedAt: record.updatedAt,
          },
        } satisfies RegisterApprovalWaitResult;
      });
    } finally {
      this.#releaseWaitIdReservation(waitId);
    }
  }

  async tick(): Promise<void> {
    if (this.#tickInProgress) {
      return;
    }

    this.#tickInProgress = true;
    try {
      if (!await this.#persistClosedSessionRetirements()) {
        return;
      }

      const nowMs = Date.parse(this.#clock.now());
      if (!Number.isFinite(nowMs)) {
        return;
      }

      const dueWaits = [...this.#waits].filter((wait) => this.#isDue(wait, nowMs));
      for (const wait of dueWaits) {
        const session = this.#sessions.find((entry) => entry.id === wait.sessionId);
        if (!session || session.lifecycle === 'closed') {
          continue;
        }

        if (!this.#isAllowedState(wait, ['pending', 'verification-delayed', 'approved-resume-queued', 'resume-dispatching'])) {
          continue;
        }

        if (wait.state === 'pending' || wait.state === 'verification-delayed') {
          await this.#refreshWait(wait, session);
          continue;
        }

        if (wait.state === 'approved-resume-queued') {
          await this.#dispatchApprovedWait(wait, session);
          continue;
        }

        if (wait.state === 'resume-dispatching') {
          await this.#recoverDispatchingWait(wait, session);
          continue;
        }
      }
    } finally {
      this.#tickInProgress = false;
    }
  }

  async recover(): Promise<void> {
    if (!await this.#persistClosedSessionRetirements()) {
      return;
    }

    const dispatching = [...this.#waits].filter((wait) => wait.state === 'resume-dispatching');
    for (const wait of dispatching) {
      const session = this.#sessions.find((entry) => entry.id === wait.sessionId);
      if (!session || session.lifecycle === 'closed') {
        continue;
      }
      await this.#recoverDispatchingWait(wait, session, true);
    }
  }

  async completeRunner(
    continuationId: string,
    runnerRunId: string,
    result: ApprovalRunnerCompletionResult | unknown,
  ): Promise<boolean> {
    if (!SHA256_PATTERN.test(continuationId) || !this.#isOpaqueToken(runnerRunId, MAX_RUNNER_RUN_ID_LENGTH)) {
      return false;
    }
    await this.#dispatchAcknowledgements.get(continuationId)?.persisted;
    const candidate = this.#waits.find((wait) => (
      wait.continuationId === continuationId
      && wait.runnerRunId === runnerRunId
      && wait.state === 'resume-dispatching'
    ));
    if (!candidate) {
      return false;
    }

    return this.#withSessionLock(candidate.sessionId, async () => {
      const wait = this.#waits.find((entry) => (
        entry === candidate
        && entry.continuationId === continuationId
        && entry.runnerRunId === runnerRunId
        && entry.state === 'resume-dispatching'
      ));
      const session = this.#sessions.find((entry) => entry.id === candidate.sessionId);
      if (!wait || !session || session.lifecycle === 'closed') {
        return false;
      }

      const sessionBefore = this.snapshotSession(session);
      const waitBefore = this.snapshotWait(wait);
      const parsed = this.#safeParseRunnerCompletion(result);
      const canonical = this.#isDispatchEvidenceCanonical(wait, session);
      const now = this.#clock.now();

      if (canonical && parsed?.status === 'succeeded' && parsed.managedThreadId === wait.managedThreadId) {
        wait.state = 'resumed';
        wait.resumedAt = now;
      } else if (!canonical || parsed?.status === 'succeeded') {
        wait.state = 'security-failure';
        delete wait.resumedAt;
      } else {
        wait.state = 'resume-reconciliation-required';
        delete wait.resumedAt;
      }
      wait.updatedAt = now;
      wait.nextCheckAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;

      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          if (wait.state === 'resumed') {
            this.#audit('approval_wait.resume_completed', 'allowed', this.#auditSummary(wait), wait.sessionId);
          } else if (wait.state === 'security-failure') {
            this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(wait), wait.sessionId);
          } else {
            this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(wait), wait.sessionId);
          }
        },
      );
      const recoveryKey = this.#runnerRecoveryKey(continuationId, runnerRunId);
      if (persisted) {
        this.#completionPersistenceFailures.delete(recoveryKey);
      } else {
        this.#completionPersistenceFailures.add(recoveryKey);
      }
      return persisted;
    });
  }

  async #persistClosedSessionRetirements(): Promise<boolean> {
    if (this.#closedSessionRetirements.length === 0) {
      return true;
    }

    const sessionIds = [...new Set(this.#closedSessionRetirements.map((wait) => wait.sessionId))];
    let allPersisted = true;

    for (const sessionId of sessionIds) {
      const persisted = await this.#withSessionLock(sessionId, async () => {
        const retired = this.#closedSessionRetirements.filter((wait) => wait.sessionId === sessionId);
        if (retired.length === 0) {
          return true;
        }

        try {
          await Promise.resolve(this.#callbacks.persist());
        } catch {
          return false;
        }

        const retiredSet = new Set(retired);
        for (let index = this.#closedSessionRetirements.length - 1; index >= 0; index -= 1) {
          if (retiredSet.has(this.#closedSessionRetirements[index])) {
            this.#closedSessionRetirements.splice(index, 1);
          }
        }
        for (const wait of retired) {
          this.#publish(wait.sessionId, this.#terminalCopy('session-closed'));
          this.#audit('approval_wait.status', 'denied', this.#auditSummary(wait), wait.sessionId);
        }
        return true;
      });
      if (!persisted) {
        allPersisted = false;
      }
    }

    return allPersisted;
  }

  async closeSessionWait(sessionId: string): Promise<void> {
    const session = this.#sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    return this.#withSessionLock(sessionId, async () => {
      const active = this.#waits.filter((wait) => wait.sessionId === sessionId && WAIT_STATES_BLOCKING.has(wait.state));
      if (active.length === 0) {
        return;
      }

      const priorGeneration = this.#sessionGeneration.get(sessionId) ?? 0;
      this.#sessionGeneration.set(sessionId, priorGeneration + 1);

      const now = this.#clock.now();
      const sessionBefore = this.snapshotSession(session);
      const waitSnapshots = active.map((wait) => ({ wait, snapshot: this.snapshotWait(wait) }));

      for (const wait of active) {
        wait.state = 'session-closed';
        wait.updatedAt = now;
        wait.nextCheckAt = now;
        delete wait.dispatchReservedAt;
        delete wait.runnerRunId;
      }
      this.projectSessionForWait(session);

      try {
        await Promise.resolve(this.#callbacks.persist());
        return;
      } catch {
        this.#sessionGeneration.set(sessionId, priorGeneration);
        this.restoreSession(session, sessionBefore);
        for (const item of waitSnapshots) {
          this.restoreWait(item.wait, item.snapshot);
        }
        throw new Error('approval_wait_close_persist_failed');
      }
    });
  }

  async failUserRun(sessionId: string, outcome: ApprovalUserRunFailure): Promise<boolean> {
    const session = this.#sessions.find((entry) => entry.id === sessionId);
    const wait = this.#waits.find((entry) => entry.sessionId === sessionId && WAIT_STATES_BLOCKING.has(entry.state));
    if (!session || !wait || session.lifecycle === 'closed') {
      return false;
    }
    return this.#withSessionLock(sessionId, async () => {
      if (!this.#waits.includes(wait) || !WAIT_STATES_BLOCKING.has(wait.state)) {
        return false;
      }
      const sessionBefore = this.snapshotSession(session);
      const waitBefore = this.snapshotWait(wait);
      wait.state = outcome === 'security-failure' ? 'security-failure' : 'resume-reconciliation-required';
      wait.updatedAt = this.#clock.now();
      wait.nextCheckAt = wait.updatedAt;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      return this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => this.projectSessionForWait(session),
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          if (wait.state === 'security-failure') {
            this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(wait), wait.sessionId);
          } else {
            this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(wait), wait.sessionId);
          }
        },
      );
    });
  }

  async reopenSessionWait(sessionId: string): Promise<ReopenApprovalWaitResult> {
    const session = this.#sessions.find((entry) => entry.id === sessionId);
    if (!session || session.lifecycle !== 'closed') {
      return 'denied';
    }
    const priorWait = this.#waits
      .filter((wait) => wait.sessionId === sessionId && wait.state === 'session-closed')
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!priorWait) {
      return 'ready';
    }

    let status: NormalizedApprovalStatus;
    try {
      status = await this.#provider.getStatus(priorWait.approvalRef, {
        projectId: priorWait.projectId,
        workspaceId: priorWait.workspaceId,
        resourceRef: priorWait.resourceRef,
      });
    } catch {
      return 'denied';
    }
    if (!this.#isWaitStatusTrusted(priorWait, status)) {
      return 'denied';
    }

    if (NON_APPROVED_DECISIONS.has(status.decision)) {
      return this.#withSessionLock(sessionId, async () => {
        if (session.lifecycle !== 'closed' || !this.#waits.includes(priorWait)) {
          return 'denied';
        }
        const sessionBefore = this.snapshotSession(session);
        session.lifecycle = 'ready';
        delete session.waitingApproval;
        try {
          await Promise.resolve(this.#callbacks.persist());
          return 'ready';
        } catch {
          this.restoreSession(session, sessionBefore);
          return 'denied';
        }
      });
    }
    if (status.decision !== 'pending' && status.decision !== 'approved') {
      return 'denied';
    }
    let consoleSurface: ApprovalConsoleSurface;
    try {
      consoleSurface = consoleForAuthority(status.authorityClass);
    } catch {
      return 'denied';
    }

    let waitId: string;
    try {
      waitId = await this.#withGlobalWaitIdReservation(async () => {
        const reservedId = this.#nextWaitId();
        this.#waitIdReservations.add(reservedId);
        return reservedId;
      });
    } catch {
      return 'denied';
    }

    let successor: ApprovalWaitRecord | undefined;
    try {
      successor = await this.#withSessionLock(sessionId, async () => {
        if (
          session.lifecycle !== 'closed'
          || !this.#waits.includes(priorWait)
          || this.#hasActiveWait(sessionId)
          || session.userId !== priorWait.userId
          || session.workspace.id !== priorWait.workspaceId
          || session.managedThreadId !== priorWait.managedThreadId
          || session.codexThreadId !== priorWait.managedThreadId
        ) {
          return undefined;
        }
        const now = this.#clock.now();
        const record: ApprovalWaitRecord = {
          id: waitId,
          sessionId,
          userId: priorWait.userId,
          projectId: status.projectId,
          workspaceId: status.workspaceId,
          managedThreadId: priorWait.managedThreadId,
          provider: 'overseer',
          approvalRef: status.approvalRef,
          resourceRef: status.resourceRef,
          authorityClass: status.authorityClass,
          consoleSurface,
          subject: status.subject,
          state: status.decision === 'approved' ? 'approved-resume-queued' : 'pending',
          decisionVersion: status.decisionVersion,
          continuationId: deriveSuccessorContinuationId(
            waitId,
            sessionId,
            status.approvalRef,
            status.decisionVersion,
          ),
          successorOfWaitId: priorWait.id,
          checkAttempt: 0,
          nextCheckAt: status.decision === 'approved' ? now : this.nextCheckAt(now, 1),
          createdAt: now,
          updatedAt: now,
          ...(status.decision === 'approved' ? { decisionObservedAt: now } : {}),
        };
        const sessionBefore = this.snapshotSession(session);
        session.lifecycle = 'ready';
        delete session.waitingApproval;
        this.#waits.push(record);
        const persisted = await this.#persistWaitTransition(
          session,
          sessionBefore,
          record,
          this.snapshotWait(record),
          () => this.projectSessionForWait(session),
          () => {
            if (record.state === 'pending') {
              this.#publish(sessionId, this.#waitingCopy(record));
              this.#audit('approval_wait.register', 'allowed', this.#auditSummary(record), sessionId);
            } else {
              this.#publish(sessionId, this.#terminalCopy(record.state));
              this.#audit('approval_wait.resume_queued', 'allowed', this.#auditSummary(record), sessionId);
            }
          },
        );
        if (!persisted) {
          const index = this.#waits.indexOf(record);
          if (index >= 0) this.#waits.splice(index, 1);
          return undefined;
        }
        return record;
      });
    } finally {
      this.#releaseWaitIdReservation(waitId);
    }
    if (!successor) {
      return 'denied';
    }
    if (successor.state === 'approved-resume-queued') {
      await this.#dispatchApprovedWait(successor, session);
    }
    return 'waiting';
  }

  hasActiveWait(sessionId: string): boolean {
    return this.#waits.some((wait) => wait.sessionId === sessionId && WAIT_STATES_BLOCKING.has(wait.state));
  }

  nextCheckAt(now: string, attempt: number): string {
    const baseDelayMs = WAIT_BASE_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), WAIT_BASE_DELAYS_MS.length - 1)];
    const jitter = this.#backoffJitter(attempt);
    const boundedJitter = Number.isFinite(jitter)
      ? Math.max(-baseDelayMs, Math.trunc(jitter))
      : 0;
    const boundedNegativeJitter = Math.min(0, boundedJitter);
    const delayMs = Math.max(0, baseDelayMs + boundedNegativeJitter);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      return now;
    }
    return new Date(nowMs + delayMs).toISOString();
  }

  async #refreshWait(wait: ApprovalWaitRecord, session: RoadexSession): Promise<void> {
    const sessionGeneration = this.#sessionGeneration.get(session.id) ?? 0;
    let status: NormalizedApprovalStatus | undefined;
    let shouldDispatch = false;
    try {
      status = await this.#provider.getStatus(wait.approvalRef, {
        projectId: wait.projectId,
        workspaceId: wait.workspaceId,
        resourceRef: wait.resourceRef,
      });
    } catch {
      status = undefined;
    }

    await this.#withSessionLock(wait.sessionId, async () => {
      const sessionBefore = this.snapshotSession(session);
      const waitBefore = this.snapshotWait(wait);
      const now = this.#clock.now();

      if (!this.#isRefreshWaitCurrentAndCanonical(wait, session, sessionGeneration)) {
        return;
      }

      wait.checkAttempt += 1;

      if (status === undefined) {
        wait.state = 'verification-delayed';
        wait.nextCheckAt = this.nextCheckAt(now, wait.checkAttempt + 1);
        wait.updatedAt = now;
        await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
          () => {
            if (waitBefore.state !== wait.state) {
              this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
            }
          },
        );
        return;
      }

      if (!this.#isWaitStatusTrusted(wait, status)) {
        wait.state = 'security-failure';
        wait.nextCheckAt = now;
        wait.updatedAt = now;
        delete wait.dispatchReservedAt;
        delete wait.runnerRunId;

        await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
          () => {
            this.#publish(wait.sessionId, this.#terminalCopy('security-failure'));
            this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(wait), wait.sessionId);
          },
        );
        return;
      }

      const shouldAdvanceDecisionVersion = status.decision === 'approved' || NON_APPROVED_DECISIONS.has(status.decision);
      if (shouldAdvanceDecisionVersion) {
        wait.decisionVersion = status.decisionVersion;
        wait.continuationId = wait.successorOfWaitId
          ? deriveSuccessorContinuationId(
            wait.id,
            wait.sessionId,
            wait.approvalRef,
            status.decisionVersion,
          )
          : deriveContinuationId(wait.sessionId, wait.approvalRef, status.decisionVersion);
      }
      wait.subject = status.subject;
      wait.updatedAt = now;

      if (status.decision === 'pending') {
        wait.state = 'pending';
        wait.nextCheckAt = this.nextCheckAt(now, wait.checkAttempt + 1);
        await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => this.projectSessionForWait(session),
          () => {
            if (waitBefore.state !== wait.state) {
              this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
            }
          },
        );
        return;
      }

      if (status.decision === 'approved') {
        wait.state = 'approved-resume-queued';
        wait.decisionObservedAt = now;
        wait.nextCheckAt = now;
        const persisted = await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
          () => {
            this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
            this.#audit('approval_wait.resume_queued', 'allowed', this.#auditSummary(wait), wait.sessionId);
          },
        );
        if (!persisted) {
          return;
        }
        shouldDispatch = true;
        return;
      }

      if (NON_APPROVED_DECISIONS.has(status.decision)) {
        wait.state = status.decision;
        wait.decisionObservedAt = now;
        wait.nextCheckAt = now;
        delete wait.dispatchReservedAt;
        delete wait.runnerRunId;

        await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
          () => {
            this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
            this.#audit(
              'approval_wait.status',
              'denied',
              this.#auditSummary(wait),
              wait.sessionId,
            );
          },
        );
        return;
      }

      wait.state = 'security-failure';
      wait.decisionObservedAt = now;
      wait.nextCheckAt = now;
      delete wait.dispatchReservedAt;
      delete wait.runnerRunId;

      await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy('security-failure'));
          this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(wait), wait.sessionId);
        },
      );
    });

    if (shouldDispatch) {
      await this.#dispatchApprovedWait(wait, session);
    }
  }

  async #dispatchApprovedWait(wait: ApprovalWaitRecord, session: RoadexSession): Promise<void> {
    const sessionGeneration = this.#sessionGeneration.get(session.id) ?? 0;
    const shouldDispatch = await this.#withSessionLock(session.id, async () => {
      if (!this.#isCurrentWaitForSession(wait, session, sessionGeneration, ['approved-resume-queued', 'resume-dispatching'])) {
        await this.#handleDispatchBindingLossBeforeQueue(wait, session, sessionGeneration);
        return false;
      }

      if (!this.#isDispatchEvidenceCanonical(wait, session)) {
        await this.#handleDispatchBindingLossBeforeQueue(wait, session, sessionGeneration);
        return false;
      }

      if (wait.state === 'approved-resume-queued') {
        const sessionBefore = this.snapshotSession(session);
        const waitBefore = this.snapshotWait(wait);
        const now = this.#clock.now();
        wait.state = 'resume-dispatching';
        wait.dispatchReservedAt = now;
        wait.updatedAt = now;
        wait.nextCheckAt = now;
        delete wait.runnerRunId;

        const reserved = await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
          () => {
            this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          },
        );
        if (!reserved) {
          return false;
        }
      }
      return true;
    });

    if (!shouldDispatch) {
      return;
    }

    if (
      !this.#isCurrentWaitForSession(wait, session, sessionGeneration, ['resume-dispatching'], true)
      || !this.#isDispatchEvidenceCanonical(wait, session)
    ) {
      await this.#withSessionLock(session.id, async () => {
        if (
          !this.#isCurrentWaitForSession(wait, session, sessionGeneration, ['resume-dispatching'], true)
          || !this.#isDispatchEvidenceCanonical(wait, session)
        ) {
          await this.#handleDispatchBindingLossBeforeQueue(wait, session, sessionGeneration);
        }
      });
      return;
    }

    const acknowledgement = this.#createDispatchAcknowledgement(wait.continuationId);
    let result: ApprovalContinuationDispatchResult | unknown;
    try {
      result = await this.#callbacks.queueContinuation(wait, buildApprovalContinuation(wait));
    } catch {
      result = { status: 'ambiguous' };
    }

    try {
      await this.#withSessionLock(session.id, async () => {
        if (!this.#isCurrentWaitForSession(wait, session, sessionGeneration, ['resume-dispatching'], true)) {
          await this.#applyDispatchResultWithBindingLoss(
            wait,
            session,
            result,
            sessionGeneration,
          );
          return;
        }

        await this.#applyDispatchResult(wait, session, result, sessionGeneration);
      });
    } finally {
      this.#releaseDispatchAcknowledgement(wait.continuationId, acknowledgement);
    }
  }

  #createDispatchAcknowledgement(continuationId: string): DispatchAcknowledgement {
    let release = () => {};
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acknowledgement = { persisted, release };
    this.#dispatchAcknowledgements.set(continuationId, acknowledgement);
    return acknowledgement;
  }

  #releaseDispatchAcknowledgement(
    continuationId: string,
    acknowledgement: DispatchAcknowledgement,
  ): void {
    acknowledgement.release();
    if (this.#dispatchAcknowledgements.get(continuationId) === acknowledgement) {
      this.#dispatchAcknowledgements.delete(continuationId);
    }
  }

  async #applyDispatchResult(
    wait: ApprovalWaitRecord,
    session: RoadexSession,
    result: ApprovalContinuationDispatchResult | unknown,
    sessionGeneration: number,
  ): Promise<void> {
    const sessionBefore = this.snapshotSession(session);
    const waitBefore = this.snapshotWait(wait);
    const now = this.#clock.now();

    if (!this.#isCurrentWaitForSession(wait, session, sessionGeneration, ['resume-dispatching'], true)) {
      return;
    }

    const parsed = this.#safeParseDispatchResult(result);

    if (parsed === null) {
      wait.state = 'resume-reconciliation-required';
      wait.updatedAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      wait.nextCheckAt = now;

      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(wait), wait.sessionId);
        },
      );
      if (!persisted) {
        return;
      }
      return;
    }

    if (parsed.status === 'started') {
      wait.state = 'resume-dispatching';
      wait.runnerRunId = parsed.runnerRunId;
      wait.dispatchReservedAt = now;
      wait.updatedAt = now;
      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          this.#audit('approval_wait.resume_dispatched', 'allowed', this.#auditSummary(wait), wait.sessionId);
        },
      );
      if (!persisted) {
        return;
      }
      return;
    }

    if (parsed.status === 'capacity') {
      wait.state = 'approved-resume-queued';
      wait.nextCheckAt = parsed.retryAt;
      wait.updatedAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          this.#audit('approval_wait.resume_queued', 'allowed', this.#auditSummary(wait), wait.sessionId);
        },
      );
      if (!persisted) {
        return;
      }
      return;
    }

    if (parsed.status === 'ambiguous') {
      wait.state = 'resume-reconciliation-required';
      wait.updatedAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(wait), wait.sessionId);
        },
      );
      if (!persisted) {
        return;
      }
      return;
    }

    wait.state = parsed.reason === 'session-closed' ? 'session-closed' : 'security-failure';
    wait.updatedAt = now;
    delete wait.runnerRunId;
    delete wait.dispatchReservedAt;

    const persisted = await this.#persistWaitTransition(
      session,
      sessionBefore,
      wait,
      waitBefore,
      () => {
        this.projectSessionForWait(session);
      },
      () => {
        if (parsed.reason === 'session-closed') {
          this.#publish(wait.sessionId, this.#terminalCopy('session-closed'));
          this.#audit('approval_wait.status', 'denied', this.#auditSummary(wait), wait.sessionId);
        } else {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(wait), wait.sessionId);
        }
      },
    );
    if (!persisted) {
      return;
    }
  }

  async #recoverDispatchingWait(
    wait: ApprovalWaitRecord,
    session: RoadexSession,
    startupRecovery = false,
  ): Promise<void> {
    await this.#withSessionLock(session.id, async () => {
      const runnerRunId = wait.runnerRunId;
      const recoveryKey = runnerRunId
        ? this.#runnerRecoveryKey(wait.continuationId, runnerRunId)
        : undefined;
      const completionPersistenceFailed = recoveryKey !== undefined
        && this.#completionPersistenceFailures.has(recoveryKey);
      if (
        wait.state !== 'resume-dispatching'
        || (!startupRecovery && runnerRunId !== undefined && !completionPersistenceFailed)
      ) {
        return;
      }

      const sessionBefore = this.snapshotSession(session);
      const waitBefore = this.snapshotWait(wait);
      const now = this.#clock.now();

      if (!this.#isDispatchEvidenceCanonical(wait, session)) {
        await this.#handleDispatchBindingLossBeforeQueue(wait, session, this.#sessionGeneration.get(session.id) ?? 0);
        return;
      }

      wait.state = 'resume-reconciliation-required';
      wait.updatedAt = now;
      wait.nextCheckAt = now;
      delete wait.dispatchReservedAt;
      delete wait.runnerRunId;

      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
        },
        () => {
          this.#publish(wait.sessionId, this.#terminalCopy(wait.state));
          this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(wait), wait.sessionId);
        },
      );
      if (persisted && recoveryKey) {
        this.#completionPersistenceFailures.delete(recoveryKey);
      }
    });
  }

  #runnerRecoveryKey(continuationId: string, runnerRunId: string): string {
    return `${continuationId}\u0000${runnerRunId}`;
  }

  async #handleDispatchBindingLossBeforeQueue(
    wait: ApprovalWaitRecord,
    session: RoadexSession,
    sessionGeneration: number,
  ): Promise<void> {
    const liveWait = this.#resolveLiveWaitForTransition(wait);
    if (!liveWait) {
      await this.#persistMissingLiveWaitOutcome(session, wait, 'security-failure');
      return;
    }
    const sessionBefore = this.snapshotSession(session);
    const waitBefore = this.snapshotWait(liveWait);
    const now = this.#clock.now();
    if (this.#isClosedDuringDispatch(session, sessionGeneration)) {
      if (liveWait.state !== 'session-closed') {
        liveWait.state = 'session-closed';
        liveWait.updatedAt = now;
        liveWait.nextCheckAt = now;
        delete liveWait.dispatchReservedAt;
        delete liveWait.runnerRunId;
        await this.#persistWaitTransition(
          session,
          sessionBefore,
          liveWait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
          },
        );
      }
      return;
    }

    liveWait.state = 'security-failure';
    liveWait.updatedAt = now;
    liveWait.nextCheckAt = now;
    delete liveWait.dispatchReservedAt;
    delete liveWait.runnerRunId;
    await this.#persistWaitTransition(
      session,
      sessionBefore,
      liveWait,
      waitBefore,
      () => {
        this.projectSessionForWait(session);
      },
      () => {
        this.#publish(liveWait.sessionId, this.#terminalCopy('security-failure'));
        this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(liveWait), liveWait.sessionId);
      },
    );
  }

  async #applyDispatchResultWithBindingLoss(
    wait: ApprovalWaitRecord,
    session: RoadexSession,
    result: ApprovalContinuationDispatchResult | unknown,
    sessionGeneration: number,
  ): Promise<void> {
    const parsed = this.#safeParseDispatchResult(result);
    const closed = this.#isClosedDuringDispatch(session, sessionGeneration);

    if (closed && parsed !== null && parsed.status === 'capacity') {
      return;
    }

    if (closed && parsed !== null && parsed.status === 'denied' && parsed.reason === 'session-closed') {
      return;
    }

    const liveWait = this.#resolveLiveWaitForTransition(wait);
    if (!liveWait) {
      await this.#persistMissingLiveWaitOutcome(session, wait, 'resume-reconciliation-required');
      return;
    }
    const sessionBefore = this.snapshotSession(session);
    const waitBefore = this.snapshotWait(liveWait);

    const now = this.#clock.now();
    liveWait.state = 'resume-reconciliation-required';
    liveWait.updatedAt = now;
    if (parsed !== null && parsed.status === 'started') {
      liveWait.runnerRunId = parsed.runnerRunId;
      liveWait.dispatchReservedAt = now;
    } else {
      delete liveWait.runnerRunId;
      delete liveWait.dispatchReservedAt;
    }

    await this.#persistWaitTransition(
      session,
      sessionBefore,
      liveWait,
      waitBefore,
      () => {
        this.projectSessionForWait(session);
      },
      () => {
        this.#publish(liveWait.sessionId, this.#terminalCopy(liveWait.state));
        this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(liveWait), liveWait.sessionId);
      },
    );
  }

  #resolveLiveWaitForTransition(wait: ApprovalWaitRecord): ApprovalWaitRecord | undefined {
    if (this.#waits.includes(wait)) {
      return wait;
    }

    return this.#waits.find((candidate) => candidate.id === wait.id && candidate.sessionId === wait.sessionId);
  }

  async #persistMissingLiveWaitOutcome(
    session: RoadexSession,
    wait: ApprovalWaitRecord,
    state: 'security-failure' | 'resume-reconciliation-required',
  ): Promise<void> {
    const sessionBefore = this.snapshotSession(session);
    if (session.lifecycle !== 'closed') {
      session.lifecycle = 'blocked';
    }
    delete session.waitingApproval;

    try {
      await Promise.resolve(this.#callbacks.persist());
    } catch {
      this.restoreSession(session, sessionBefore);
      return;
    }

    const summaryWait = { ...wait, state };
    if (state === 'security-failure') {
      this.#publish(session.id, this.#terminalCopy(state));
      this.#audit('approval_wait.security_failure', 'denied', this.#auditSummary(summaryWait), session.id);
      return;
    }
    this.#publish(session.id, this.#terminalCopy(state));
    this.#audit('approval_wait.reconciliation_required', 'denied', this.#auditSummary(summaryWait), session.id);
  }

  async #persistWaitTransition(
    session: RoadexSession,
    sessionBefore: SessionSnapshot,
    wait: ApprovalWaitRecord,
    waitBefore: ApprovalWaitRecord,
    transition: () => void | Promise<void>,
    publish: () => void | Promise<void> = () => {},
  ): Promise<boolean> {
    try {
      await Promise.resolve(transition());
      await Promise.resolve(this.#callbacks.persist());
    } catch {
      this.restoreSession(session, sessionBefore);
      this.restoreWait(wait, waitBefore);
      return false;
    }

    try {
      await Promise.resolve(publish());
    } catch {
      // Persisted state is canonical; callback exceptions must not roll back memory.
    }

    return true;
  }

  #isDue(wait: ApprovalWaitRecord, nowMs: number): boolean {
    return WAIT_DUE_STATES.has(wait.state) && Date.parse(wait.nextCheckAt) <= nowMs;
  }

  #parseDispatchResult(value: unknown): ApprovalContinuationDispatchResult | null {
    const candidate = this.#readOwnEnumerableDataProperties(value);
    if (candidate === null) {
      return null;
    }

    const status = candidate.get('status');

    if (status === 'started') {
      if (!this.#hasExactPropertyKeys(candidate, ['status', 'runnerRunId'])) {
        return null;
      }
      const runnerRunId = candidate.get('runnerRunId');
      if (typeof runnerRunId !== 'string' || !this.#isOpaqueToken(runnerRunId, MAX_RUNNER_RUN_ID_LENGTH)) {
        return null;
      }
      return { status: 'started', runnerRunId };
    }

    if (status === 'capacity') {
      if (!this.#hasExactPropertyKeys(candidate, ['status', 'retryAt'])) {
        return null;
      }
      const retryAt = candidate.get('retryAt');
      if (typeof retryAt !== 'string') {
        return null;
      }
      if (!this.#isRetryAt(retryAt, this.#clock.now())) {
        return null;
      }
      return { status: 'capacity', retryAt };
    }

    if (status === 'ambiguous') {
      if (!this.#hasExactPropertyKeys(candidate, ['status'])) {
        return null;
      }
      return { status: 'ambiguous' };
    }

    if (status === 'denied') {
      if (!this.#hasExactPropertyKeys(candidate, ['status', 'reason'])) {
        return null;
      }
      const reason = candidate.get('reason');
      if (reason !== 'session-closed' && reason !== 'thread-mismatch' && reason !== 'scope-mismatch') {
        return null;
      }
      return { status: 'denied', reason };
    }

    return null;
  }

  #readOwnEnumerableDataProperties(value: unknown): Map<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }

    const properties = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      properties.set(key, descriptor.value);
    }
    return properties;
  }

  #hasExactPropertyKeys(properties: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean {
    if (properties.size !== keys.length) {
      return false;
    }
    return keys.every((key) => properties.has(key));
  }

  #safeParseDispatchResult(value: unknown): ApprovalContinuationDispatchResult | null {
    try {
      return this.#parseDispatchResult(value);
    } catch {
      return null;
    }
  }

  #safeParseRunnerCompletion(value: unknown): ApprovalRunnerCompletionResult | null {
    try {
      const candidate = this.#readOwnEnumerableDataProperties(value);
      if (candidate === null) {
        return null;
      }
      const status = candidate.get('status');
      if (status === 'failed' && this.#hasExactPropertyKeys(candidate, ['status'])) {
        return { status: 'failed' };
      }
      if (status !== 'succeeded' || !this.#hasExactPropertyKeys(candidate, ['status', 'managedThreadId'])) {
        return null;
      }
      const managedThreadId = candidate.get('managedThreadId');
      if (typeof managedThreadId !== 'string' || !this.#isFieldValid(managedThreadId)) {
        return null;
      }
      return { status: 'succeeded', managedThreadId };
    } catch {
      return null;
    }
  }

  #isWaitStatusTrusted(wait: ApprovalWaitRecord, status: NormalizedApprovalStatus): boolean {
    if (status.decision === 'approved' || status.decision === 'pending' || NON_APPROVED_DECISIONS.has(status.decision)) {
      if (!this.#isFieldValid(status.approvalRef)
        || !this.#isFieldValid(status.projectId)
        || !this.#isFieldValid(status.workspaceId)
        || !this.#isFieldValid(status.resourceRef)
        || !this.#isFieldValid(status.subject)
      ) {
        return false;
      }

      return status.approvalRef === wait.approvalRef
        && status.projectId === wait.projectId
        && status.workspaceId === wait.workspaceId
        && status.resourceRef === wait.resourceRef
        && status.authorityClass === wait.authorityClass
        && SHA256_PATTERN.test(status.decisionVersion)
        && status.provider === 'overseer';
    }

    return false;
  }

  #isFieldValid(value: string, maxLength = MAX_FIELD_LENGTH): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
      return false;
    }
    if (value.trim() !== value) {
      return false;
    }
    for (let i = 0; i < value.length; i++) {
      const codePoint = value.charCodeAt(i);
      if (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
        return false;
      }
    }
    return true;
  }

  #isOpaqueToken(value: string, maxLength = MAX_WAIT_ID_LENGTH): boolean {
    return this.#isFieldValid(value, maxLength) && OPAQUE_TOKEN_PATTERN.test(value);
  }

  #isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) {
      return false;
    }

    const symbolCount = ownKeys.filter((key) => typeof key === 'symbol').length;
    if (symbolCount > 0) {
      return false;
    }

    const ownStringKeys = [...ownKeys] as Array<string>;
    const expected = [...keys].sort();
    const actual = ownStringKeys.sort();
    for (let index = 0; index < expected.length; index += 1) {
      if (expected[index] !== actual[index]) {
        return false;
      }
    }

    for (const key of ownStringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return false;
      }
    }

    return true;
  }

  #isRetryAt(value: string, now: string): boolean {
    if (!RETRY_AT_PATTERN.test(value)) {
      return false;
    }

    const retryAtTime = new Date(value).getTime();
    if (!Number.isFinite(retryAtTime) || new Date(retryAtTime).toISOString() !== value) {
      return false;
    }

    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) {
      return false;
    }

    const delayMs = retryAtTime - nowMs;
    if (delayMs <= 0) {
      return false;
    }

    return delayMs <= WAIT_BASE_DELAYS_MS[WAIT_BASE_DELAYS_MS.length - 1];
  }

  #isClosedDuringDispatch(session: RoadexSession, sessionGeneration: number): boolean {
    const currentGeneration = this.#sessionGeneration.get(session.id) ?? sessionGeneration;
    return currentGeneration > sessionGeneration;
  }

  #isRefreshWaitCurrentAndCanonical(wait: ApprovalWaitRecord, session: RoadexSession, sessionGeneration: number): boolean {
    if (!this.#waits.includes(wait)) {
      return false;
    }
    if ((this.#sessionGeneration.get(session.id) ?? 0) !== sessionGeneration) {
      return false;
    }
    if (session.id !== wait.sessionId || session.userId !== wait.userId || session.workspace.id !== wait.workspaceId) {
      return false;
    }
    if (!session.managedThreadId || session.managedThreadId !== wait.managedThreadId || session.codexThreadId !== session.managedThreadId) {
      return false;
    }
    if (session.lifecycle !== 'paused') {
      return false;
    }
    if (!this.#isCanonicalWaitingSummary(wait, session.waitingApproval)) {
      return false;
    }
    return this.#isAllowedState(wait, ['pending', 'verification-delayed']);
  }

  #isCurrentWaitForSession(
    wait: ApprovalWaitRecord,
    session: RoadexSession,
    sessionGeneration: number,
    states?: ReadonlySet<ApprovalWaitState> | ReadonlyArray<ApprovalWaitState>,
    requireDispatchBinding = false,
  ): boolean {
    if (!this.#waits.includes(wait)) {
      return false;
    }
    if ((this.#sessionGeneration.get(session.id) ?? 0) !== sessionGeneration) {
      return false;
    }
    if (session.id !== wait.sessionId || session.userId !== wait.userId || session.workspace.id !== wait.workspaceId) {
      return false;
    }
    if (!session.managedThreadId || session.managedThreadId !== wait.managedThreadId || session.codexThreadId !== session.managedThreadId) {
      return false;
    }
    if (requireDispatchBinding) {
      if (session.lifecycle !== 'paused') {
        return false;
      }
      if (session.waitingApproval?.waitId !== wait.id) {
        return false;
      }
      if (session.waitingApproval?.state !== wait.state) {
        return false;
      }
    }
    return states === undefined || this.#isAllowedState(wait, states);
  }

  #nextWaitId(): string {
    for (let index = 0; index < MAX_WAIT_ID_GENERATION_ATTEMPTS; index += 1) {
      let nextId: string;
      try {
        nextId = this.#idSource.generateWaitId();
      } catch {
        break;
      }

      if (!this.#isOpaqueToken(nextId, MAX_WAIT_ID_LENGTH)) {
        continue;
      }
      if (this.#waitIdReservations.has(nextId) || this.#waits.some((wait) => wait.id === nextId)) {
        continue;
      }

      return nextId;
    }

    throw new Error('Unable to generate unique wait id.');
  }

  #isAllowedState(
    wait: ApprovalWaitRecord,
    states: ReadonlySet<ApprovalWaitState> | ReadonlyArray<ApprovalWaitState>,
  ): boolean {
    for (const state of states) {
      if (state === wait.state) {
        return true;
      }
    }
    return false;
  }

  #publish(sessionId: string, message: string): void {
    try {
      this.#callbacks.publish(sessionId, message);
    } catch {
      // Callback exceptions must not fail transitions.
    }
  }

  #audit(action: AuditEvent['action'], outcome: AuditEvent['outcome'], summary: string, resource: string): void {
    try {
      this.#callbacks.audit(action, outcome, summary, resource);
    } catch {
      // Callback exceptions must not fail transitions.
    }
  }

  private projectSessionForWait(session: RoadexSession): void {
    if (session.lifecycle === 'closed') {
      delete session.waitingApproval;
      return;
    }

    const active = this.#waits
      .filter((wait) => wait.sessionId === session.id && PUBLISHED_WAIT_STATES.has(wait.state as PublicWaitState))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];

    if (!active) {
      delete session.waitingApproval;
      if (session.lifecycle === 'paused') {
        session.lifecycle = 'ready';
      }
      return;
    }

    session.lifecycle = 'paused';
    session.waitingApproval = this.toPublic(active);
  }

  private toPublic(wait: ApprovalWaitRecord): WaitingApprovalSummary {
    if (!PUBLISHED_WAIT_STATES.has(wait.state as PublicWaitState)) {
      throw new Error('wait-state-not-public');
    }

    return {
      waitId: wait.id,
      approvalRef: wait.approvalRef,
      subject: wait.subject,
      consoleSurface: wait.consoleSurface,
      state: wait.state as PublicWaitState,
      updatedAt: wait.updatedAt,
    };
  }

  #waitingCopy(wait: ApprovalWaitRecord): string {
    const consoleName = wait.consoleSurface === 'admin' ? 'Admin Console' : 'Overview Console';
    return `Roadex is waiting for human approval in ${consoleName}. Roadex will continue automatically after verified approval.`;
  }

  #terminalCopy(state: string): string {
    return `Roadex human approval result: ${state}`;
  }

  #auditSummary(wait: ApprovalWaitRecord): string {
    return `wait=${wait.id};state=${wait.state};console=${wait.consoleSurface}`;
  }

  snapshotSession(session: RoadexSession): SessionSnapshot {
    return {
      lifecycle: session.lifecycle,
      waitingApproval: session.waitingApproval ? { ...session.waitingApproval } : undefined,
    };
  }

  snapshotWait(wait: ApprovalWaitRecord): ApprovalWaitRecord {
    return { ...wait };
  }

  restoreSession(session: RoadexSession, snapshot: SessionSnapshot): void {
    session.lifecycle = snapshot.lifecycle;
    if (snapshot.waitingApproval === undefined) {
      delete session.waitingApproval;
      return;
    }
    session.waitingApproval = { ...snapshot.waitingApproval };
  }

  restoreWait(wait: ApprovalWaitRecord, snapshot: ApprovalWaitRecord): void {
    const keys = Object.keys(wait) as Array<keyof ApprovalWaitRecord>;
    keys.forEach((key) => {
      delete wait[key];
    });
    Object.assign(wait, snapshot);
  }
}

function isAllowedLifecycleForRegistration(lifecycle: RoadexSession['lifecycle']): boolean {
  return lifecycle === 'ready' || lifecycle === 'paused';
}

function deriveContinuationId(sessionId: string, approvalRef: string, decisionVersion: string): string {
  const canonical = JSON.stringify([sessionId, approvalRef, decisionVersion]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function deriveSuccessorContinuationId(
  waitId: string,
  sessionId: string,
  approvalRef: string,
  decisionVersion: string,
): string {
  const canonical = JSON.stringify([
    'roadex-approval-successor-v1',
    waitId,
    sessionId,
    approvalRef,
    decisionVersion,
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
