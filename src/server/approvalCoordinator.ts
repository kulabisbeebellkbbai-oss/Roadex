import { createHash } from 'node:crypto';
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
};

export type RegisterApprovalWaitInput = {
  provider: 'overseer';
  approvalRef: string;
};

export type RegisterApprovalWaitResult =
  | {
      ok: true;
      wait: {
        waitId: string;
        state: 'pending';
        consoleSurface: ApprovalConsoleSurface;
        consolePath?: string;
        approvalRef: string;
        subject: string;
      };
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

export type ApprovalCoordinatorStateClock = {
  now: () => string;
};

export type ApprovalCoordinatorCallbacks = {
  persist: () => void | Promise<void>;
  publish: (message: string) => void;
  audit: (action: AuditEvent['action'], outcome: AuditEvent['outcome'], summary: string, resource: string) => void;
  queueContinuation: (wait: ApprovalWaitRecord, prompt: string) => Promise<ApprovalContinuationDispatchResult>;
};

type ApprovalCoordinatorOptions = {
  clock?: ApprovalCoordinatorStateClock;
  idSource?: { generateWaitId: () => string };
  backoffJitter?: (attempt: number) => number;
};

type PublicWaitState = WaitingApprovalSummary['state'];

type SessionSnapshot = { lifecycle: RoadexSession['lifecycle']; waitingApproval?: WaitingApprovalSummary };

const WAIT_BASE_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];
const MAX_FIELD_LENGTH = 256;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

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

function deriveContinuationId(sessionId: string, approvalRef: string, decisionVersion: string): string {
  const canonical = JSON.stringify([sessionId, approvalRef, decisionVersion]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class ApprovalCoordinator {
  readonly #waits: ApprovalWaitRecord[];
  readonly #sessions: RoadexSession[];
  readonly #provider: ApprovalStatusProvider;
  readonly #callbacks: ApprovalCoordinatorCallbacks;
  readonly #clock: ApprovalCoordinatorStateClock;
  readonly #idSource: { generateWaitId: () => string };
  readonly #backoffJitter: (attempt: number) => number;

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
    this.#idSource = options.idSource ?? { generateWaitId: () => `wait-${Math.random().toString(16).slice(2, 12)}` };
    this.#backoffJitter = options.backoffJitter ?? (() => 0);

    this.#sessions.forEach((session) => {
      this.projectSessionForWait(session);
    });
  }

  async register(capability: ApprovalSessionCapability, input: RegisterApprovalWaitInput): Promise<RegisterApprovalWaitResult> {
    if (input.provider !== 'overseer') {
      return { ok: false, code: 'scope-mismatch' };
    }

    const now = this.#clock.now();
    const session = this.#sessions.find((entry) => entry.id === capability.sessionId);

    if (
      !session
      || !this.#isFieldValid(capability.sessionId)
      || !this.#isFieldValid(capability.userId)
      || !this.#isFieldValid(capability.projectId)
      || !this.#isFieldValid(capability.workspaceId)
      || !this.#isFieldValid(capability.resourceRef)
      || !this.#isFieldValid(capability.managedThreadId)
      || !this.#isFieldValid(input.approvalRef)
    ) {
      return { ok: false, code: 'scope-mismatch' };
    }

    if (!isAllowedLifecycleForRegistration(session.lifecycle)) {
      return { ok: false, code: 'scope-mismatch' };
    }

    if (
      session.userId !== capability.userId
      || session.workspace.id !== capability.workspaceId
      || !session.managedThreadId
      || session.managedThreadId !== capability.managedThreadId
      || session.codexThreadId !== session.managedThreadId
    ) {
      return { ok: false, code: 'scope-mismatch' };
    }

    if (this.hasActiveWait(session.id)) {
      return { ok: false, code: 'active-wait-exists' };
    }

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

    const record: ApprovalWaitRecord = {
      id: this.#idSource.generateWaitId(),
      sessionId: session.id,
      userId: session.userId,
      projectId: status.projectId,
      workspaceId: status.workspaceId,
      managedThreadId: session.managedThreadId,
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
    const waitIndex = this.#waits.length;
    this.#waits.push(record);
    this.projectSessionForWait(session);

    try {
      await Promise.resolve(this.#callbacks.persist());
      this.#callbacks.publish(this.#waitingCopy(record));
      this.#callbacks.audit('approval_wait.register', 'allowed', this.#auditSummary(record), record.sessionId);
    } catch {
      this.#waits.splice(waitIndex, 1);
      this.restoreSession(session, sessionBefore);
      return { ok: false, code: 'provider-unavailable' };
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
      },
    };
  }

  async tick(): Promise<void> {
    if (this.#tickInProgress) {
      return;
    }

    this.#tickInProgress = true;
    try {
      const nowMs = Date.parse(this.#clock.now());
      if (!Number.isFinite(nowMs)) {
        return;
      }

      const dueWaits = [...this.#waits].filter((wait) => this.#isDue(wait, nowMs));
      for (const wait of dueWaits) {
        const session = this.#sessions.find((entry) => entry.id === wait.sessionId);
        if (!session) {
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

  closeSessionWait(sessionId: string): void {
    const session = this.#sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    const active = this.#waits.filter((wait) => wait.sessionId === sessionId && WAIT_STATES_BLOCKING.has(wait.state));
    if (active.length === 0) {
      return;
    }

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

    void (async () => {
      try {
        await Promise.resolve(this.#callbacks.persist());
      } catch {
        this.restoreSession(session, sessionBefore);
        for (const item of waitSnapshots) {
          this.restoreWait(item.wait, item.snapshot);
        }
      }
    })();
  }

  hasActiveWait(sessionId: string): boolean {
    const session = this.#sessions.find((entry) => entry.id === sessionId);
    if (session?.waitingApproval !== undefined) {
      return WAIT_STATES_BLOCKING.has(session.waitingApproval.state as ApprovalWaitState);
    }

    return this.#waits.some((wait) => wait.sessionId === sessionId && WAIT_STATES_BLOCKING.has(wait.state));
  }

  nextCheckAt(now: string, attempt: number): string {
    const baseDelayMs = WAIT_BASE_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), WAIT_BASE_DELAYS_MS.length - 1)];
    const jitter = this.#backoffJitter(attempt);
    const roundedJitter = Number.isFinite(jitter) ? Math.trunc(jitter) : 0;
    const boundedJitter = Math.max(-baseDelayMs, Math.min(baseDelayMs, roundedJitter));
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      return now;
    }
    return new Date(nowMs + baseDelayMs + boundedJitter).toISOString();
  }

  async #refreshWait(wait: ApprovalWaitRecord, session: RoadexSession): Promise<void> {
    const sessionBefore = this.snapshotSession(session);
    const waitBefore = this.snapshotWait(wait);
    const now = this.#clock.now();

    wait.checkAttempt += 1;

    let status: NormalizedApprovalStatus;
    try {
      status = await this.#provider.getStatus(wait.approvalRef, {
        projectId: wait.projectId,
        workspaceId: wait.workspaceId,
        resourceRef: wait.resourceRef,
      });
    } catch {
      wait.state = 'verification-delayed';
      wait.nextCheckAt = this.nextCheckAt(now, wait.checkAttempt);
      wait.updatedAt = now;
      await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => this.projectSessionForWait(session),
      );
      return;
    }

    if (!this.#isWaitStatusTrusted(wait, status)) {
      wait.state = 'security-failure';
      wait.decisionVersion = status.decisionVersion;
      wait.decisionObservedAt = now;
      wait.nextCheckAt = now;
      wait.updatedAt = now;
      delete wait.dispatchReservedAt;
      delete wait.runnerRunId;

      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
          this.#callbacks.publish(this.#terminalCopy('security-failure'));
          this.#callbacks.audit(
            'approval_wait.security_failure',
            'denied',
            this.#auditSummary(wait),
            wait.sessionId,
          );
        },
      );
      if (!persisted) {
        return;
      }
      return;
    }

    wait.decisionVersion = status.decisionVersion;
    wait.subject = status.subject;
    wait.updatedAt = now;

    if (status.decision === 'pending') {
      wait.state = 'pending';
      wait.nextCheckAt = this.nextCheckAt(now, wait.checkAttempt);
      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => this.projectSessionForWait(session),
      );
      if (!persisted) {
        return;
      }
      return;
    }

    if (status.decision === 'approved') {
      wait.state = 'approved-resume-queued';
      wait.continuationId = deriveContinuationId(wait.sessionId, wait.approvalRef, status.decisionVersion);
      wait.decisionObservedAt = now;
      wait.nextCheckAt = now;

      const persisted = await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
          this.#callbacks.audit(
            'approval_wait.status',
            'allowed',
            this.#auditSummary(wait),
            wait.sessionId,
          );
        },
      );
      if (!persisted) {
        return;
      }
      await this.#dispatchApprovedWait(wait, session);
      return;
    }

    if (NON_APPROVED_DECISIONS.has(status.decision)) {
      wait.state = status.decision;
      wait.decisionObservedAt = now;
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
          this.#callbacks.publish(this.#terminalCopy(wait.state));
          this.#callbacks.audit(
            'approval_wait.status',
            'denied',
            this.#auditSummary(wait),
            wait.sessionId,
          );
        },
      );
      if (!persisted) {
        return;
      }
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
        this.#callbacks.publish(this.#terminalCopy('security-failure'));
        this.#callbacks.audit(
          'approval_wait.security_failure',
          'denied',
          this.#auditSummary(wait),
          wait.sessionId,
        );
      },
    );
  }

  async #dispatchApprovedWait(wait: ApprovalWaitRecord, session: RoadexSession): Promise<void> {
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
        this.#callbacks.audit(
          'approval_wait.resume_dispatched',
          'allowed',
          this.#auditSummary(wait),
          wait.sessionId,
        );
      },
    );
    if (!reserved) {
      return;
    }

    let result: ApprovalContinuationDispatchResult;
    try {
      result = await this.#callbacks.queueContinuation(wait, buildApprovalContinuation(wait));
    } catch {
      result = { status: 'ambiguous' };
    }

    await this.#applyDispatchResult(wait, session, result);
  }

  async #applyDispatchResult(
    wait: ApprovalWaitRecord,
    session: RoadexSession,
    result: ApprovalContinuationDispatchResult | unknown,
  ): Promise<void> {
    const now = this.#clock.now();
    const sessionBefore = this.snapshotSession(session);
    const waitBefore = this.snapshotWait(wait);

    if (this.#isDispatchResult(result) && result.status === 'started') {
      wait.state = 'resume-dispatching';
      wait.runnerRunId = result.runnerRunId;
      wait.dispatchReservedAt = now;
      wait.updatedAt = now;
      await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
          this.#callbacks.audit(
            'approval_wait.resume_dispatched',
            'allowed',
            this.#auditSummary(wait),
            wait.sessionId,
          );
        },
      );
      return;
    }

    if (this.#isDispatchResult(result) && result.status === 'capacity') {
      if (!this.#isRetryAt(result.retryAt)) {
        wait.state = 'resume-reconciliation-required';
        wait.nextCheckAt = now;
        wait.updatedAt = now;
        delete wait.runnerRunId;
        delete wait.dispatchReservedAt;
        await this.#persistWaitTransition(
          session,
          sessionBefore,
          wait,
          waitBefore,
          () => {
            this.projectSessionForWait(session);
            this.#callbacks.audit(
              'approval_wait.reconciliation_required',
              'denied',
              this.#auditSummary(wait),
              wait.sessionId,
            );
          },
        );
        return;
      }

      wait.state = 'approved-resume-queued';
      wait.nextCheckAt = result.retryAt;
      wait.updatedAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
          this.#callbacks.audit(
            'approval_wait.resume_queued',
            'allowed',
            this.#auditSummary(wait),
            wait.sessionId,
          );
        },
      );
      return;
    }

    if (this.#isDispatchResult(result) && result.status === 'ambiguous') {
      wait.state = 'resume-reconciliation-required';
      wait.updatedAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
          this.#callbacks.audit(
            'approval_wait.reconciliation_required',
            'denied',
            this.#auditSummary(wait),
            wait.sessionId,
          );
        },
      );
      return;
    }

    if (this.#isDispatchResult(result) && result.status === 'denied') {
      wait.state = result.reason === 'session-closed' ? 'session-closed' : 'security-failure';
      wait.updatedAt = now;
      delete wait.runnerRunId;
      delete wait.dispatchReservedAt;
      await this.#persistWaitTransition(
        session,
        sessionBefore,
        wait,
        waitBefore,
        () => {
          this.projectSessionForWait(session);
          const action = result.reason === 'session-closed'
            ? 'approval_wait.reconciliation_required'
            : 'approval_wait.security_failure';
          this.#callbacks.audit(action, 'denied', this.#auditSummary(wait), wait.sessionId);
        },
      );
      return;
    }

    wait.state = 'resume-reconciliation-required';
    wait.updatedAt = now;
    delete wait.runnerRunId;
    delete wait.dispatchReservedAt;
    await this.#persistWaitTransition(
      session,
      sessionBefore,
      wait,
      waitBefore,
      () => {
        this.projectSessionForWait(session);
        this.#callbacks.audit(
          'approval_wait.reconciliation_required',
          'denied',
          this.#auditSummary(wait),
          wait.sessionId,
        );
      },
    );
  }

  async #recoverDispatchingWait(wait: ApprovalWaitRecord, session: RoadexSession): Promise<void> {
    if (wait.runnerRunId !== undefined) {
      return;
    }

    const sessionBefore = this.snapshotSession(session);
    const waitBefore = this.snapshotWait(wait);
    const now = this.#clock.now();

    wait.state = 'resume-reconciliation-required';
    wait.updatedAt = now;
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
        this.#callbacks.audit(
          'approval_wait.reconciliation_required',
          'denied',
          this.#auditSummary(wait),
          wait.sessionId,
        );
      },
    );
  }

  async #persistWaitTransition(
    session: RoadexSession,
    sessionBefore: SessionSnapshot,
    wait: ApprovalWaitRecord,
    waitBefore: ApprovalWaitRecord,
    transition: () => void | Promise<void>,
  ): Promise<boolean> {
    try {
      await Promise.resolve(this.#callbacks.persist());
      await Promise.resolve(transition());
      return true;
    } catch {
      this.restoreSession(session, sessionBefore);
      this.restoreWait(wait, waitBefore);
      return false;
    }
  }

  #isDue(wait: ApprovalWaitRecord, nowMs: number): boolean {
    return WAIT_DUE_STATES.has(wait.state) && Date.parse(wait.nextCheckAt) <= nowMs;
  }

  #isDispatchResult(value: unknown): value is ApprovalContinuationDispatchResult {
    if (value === null || typeof value !== 'object') {
      return false;
    }
    const candidate = value as { status?: string };
    if (candidate.status === 'started' || candidate.status === 'ambiguous' || candidate.status === 'denied') {
      return true;
    }
    if (candidate.status === 'capacity') {
      return typeof (value as { retryAt?: unknown }).retryAt === 'string';
    }
    return false;
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

  #isFieldValid(value: string): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_LENGTH) {
      return false;
    }
    if (value.trim() !== value) {
      return false;
    }
    for (let i = 0; i < value.length; i++) {
      const codePoint = value.charCodeAt(i);
      if (codePoint < 0x20 || codePoint === 0x7f) {
        return false;
      }
    }
    return true;
  }

  #isRetryAt(value: string): boolean {
    const when = Date.parse(value);
    return Number.isFinite(when);
  }

  private projectSessionForWait(session: RoadexSession): void {
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
