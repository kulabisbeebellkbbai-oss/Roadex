# Roadex Human-Approval Continuation Design

## Purpose

Roadex must give future managed projects a reusable way to pause at a human
approval gate, tell the user exactly where approval is required, and continue
the same managed Codex thread automatically after the authoritative approval
system reports an approved decision.

DonutHole provisioning is the representative workflow. The feature is generic
to Roadex and must not contain DonutHole-specific policy, paths, approval IDs,
or continuation text.

## Goals

- Persist approval waits on the Roadex server so they survive browser and
  service reconnects.
- Distinguish a healthy thread waiting for a human from a broken or blocked
  thread.
- Direct privileged operational approvals to the admin console and
  project/workflow approvals to the overview console.
- Resume the same managed thread after an exact authoritative approval.
- Report non-approved outcomes without automatically advancing execution.
- Preserve strict approval ownership: Roadex observes decisions but cannot
  create, modify, infer, or grant them.
- Provide a narrow process that future Roadex-controlled projects can invoke.

## Non-Goals

- Adding an approval button to the Roadex thread.
- Allowing a model or project to choose a console URL or claim an approval
  outcome.
- Parsing assistant prose to discover approval waits.
- Scanning or dispatching a broad approval queue.
- Activating gateway routes, changing firewall or IDS policy, provisioning
  storage, or performing another privileged operation as part of this feature.
- Replacing the authoritative approval system or its admin and overview
  consoles.

## Architecture

The feature consists of five focused units:

1. `ApprovalWaitStore` persists approval waits and continuation delivery state
   alongside existing Roadex state.
2. `ApprovalStatusProvider` reads one exact approval record from an
   authoritative provider and returns a normalized, redacted decision.
3. `ApprovalCoordinator` validates registrations, schedules exact status
   checks, and owns durable state transitions.
4. `ContinuationDispatcher` submits a fixed server-generated continuation to
   the same managed thread through an internal runner API.
5. The session projection and browser UI expose the active wait and its safe
   console destination.

The controlled project thread registers a wait through a narrow Roadex MCP
tool. The tool can request a pause but cannot approve anything. Roadex validates
the referenced approval against the authoritative provider before persisting an
active wait.

The coordinator runs independently of browser connections. It starts with the
Roadex service, reconstructs pending work from persisted state, and checks only
the exact provider and approval reference stored on each wait.

## Authority and Trust Boundaries

The controlled Codex thread is untrusted for approval decisions and navigation
targets. Its wait-registration call supplies only:

```ts
type AwaitHumanApprovalInput = {
  provider: 'overseer';
  approvalRef: string;
};
```

The Roadex MCP process derives the session, authenticated owner, workspace, and
managed thread from a server-issued, single-session capability. The caller
cannot submit those bindings.

The provider returns normalized authority metadata:

```ts
type ApprovalAuthorityClass = 'privileged-operation' | 'project-workflow';

type ApprovalDecision =
  | 'pending'
  | 'approved'
  | 'changes-requested'
  | 'rejected'
  | 'expired'
  | 'revoked';

type NormalizedApprovalStatus = {
  provider: 'overseer';
  approvalRef: string;
  authorityClass: ApprovalAuthorityClass;
  decision: ApprovalDecision;
  decisionVersion: string;
  projectId: string;
  workspaceId: string;
  resourceRef: string;
  subject: string;
  updatedAt: string;
};
```

Provider implementations must validate the current Roadex owner, project,
workspace, and resource binding before returning a usable record. Raw approval
bodies, credentials, secret values, unrestricted URLs, and unredacted provider
errors never enter Roadex persistence, logs, stream events, or browser payloads.

Roadex maps authority class to console surface without caller discretion:

```ts
type ApprovalConsoleSurface = 'admin' | 'overview';

const consoleForAuthority: Record<ApprovalAuthorityClass, ApprovalConsoleSurface> = {
  'privileged-operation': 'admin',
  'project-workflow': 'overview',
};
```

Console navigation uses a deployment-owned enum-to-relative-path allowlist.
Provider data and MCP input cannot supply a URL. If no safe path is configured,
Roadex displays the correct console name without rendering a link.

## Persisted State

Approval waits are stored separately from `RoadexSession` so lifecycle history
does not inflate the session object and one active wait can coexist with
terminal historical records.

```ts
type ApprovalWaitState =
  | 'pending'
  | 'verification-delayed'
  | 'security-failure'
  | 'changes-requested'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'approved-resume-queued'
  | 'resume-dispatching'
  | 'resume-reconciliation-required'
  | 'resumed'
  | 'session-closed';

type ApprovalWaitRecord = {
  id: string;
  sessionId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  managedThreadId: string;
  provider: 'overseer';
  approvalRef: string;
  resourceRef: string;
  authorityClass: ApprovalAuthorityClass;
  consoleSurface: ApprovalConsoleSurface;
  subject: string;
  state: ApprovalWaitState;
  decisionVersion: string;
  continuationId: string;
  checkAttempt: number;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
  decisionObservedAt?: string;
  dispatchReservedAt?: string;
  runnerRunId?: string;
  resumedAt?: string;
};
```

Only one non-terminal wait may exist for a session. Registration of another
wait fails with a typed `active-wait-exists` result.

The public session projection exposes only the safe active summary:

```ts
type WaitingApprovalSummary = {
  waitId: string;
  approvalRef: string;
  subject: string;
  consoleSurface: ApprovalConsoleSurface;
  consolePath?: string;
  state:
    | 'pending'
    | 'verification-delayed'
    | 'security-failure'
    | 'approved-resume-queued'
    | 'resume-dispatching'
    | 'resume-reconciliation-required';
  updatedAt: string;
};
```

While a wait is `pending` or `verification-delayed`, the session lifecycle is
`paused`. This means the session is healthy and intentionally waiting. New user
prompts are rejected with a typed `human-approval-pending` response.

## Registration Contract

The controlled-runner MCP server exposes:

```text
roadex_workflow.await_human_approval
```

Registration succeeds only when all of the following are true:

- The server-issued session capability is current and scoped to the calling
  session, user, workspace, and managed thread.
- The session is neither streaming, closed, blocked, nor already waiting.
- The provider is enabled and reachable.
- The exact approval record exists and reports `pending`.
- The provider record matches the current project and workspace.
- The resource reference is valid for that provider and scope.
- The authority class maps to a known Roadex console surface.

Roadex persists the wait before returning success or emitting a stream event.
The successful tool result contains the safe wait ID, console surface, subject,
and the statement that Roadex will continue automatically after verified
approval. It never contains approval credentials or provider internals.

## State Transitions

### Pending decision

The coordinator checks the exact approval record using bounded exponential
backoff with jitter. Provider unavailability changes `pending` to
`verification-delayed`; recovery changes it back to `pending`. Neither state
permits a prompt or continuation.

The coordinator does not call an unfiltered dispatcher, list unrelated
approvals, or treat message delivery, acknowledgment, staging, health, claim,
or `waiting_human_approval` as approval.

### Approved decision

After the provider returns `approved`, Roadex revalidates every stored binding
and the provider decision version. It then persists
`approved-resume-queued` with the precomputed deterministic continuation ID.

The continuation contains fixed server-owned text:

```text
[Roadex verified human approval]
Approval reference: <approvalRef>
Decision version: <decisionVersion>
Continue the previously paused workflow within the exact approved scope.
Do not broaden the approved operation or infer approval for another gate.
```

The dispatcher submits this text through an internal system-continuation API;
it never calls the browser-facing user prompt endpoint. The runner receives the
same managed thread ID and a server-generated continuation ID.

Runner-capacity exhaustion leaves the wait in `approved-resume-queued` and
retries without requesting approval again.

Before spawning the continuation, the dispatcher durably changes the state to
`resume-dispatching`. After the runner acknowledges the run, Roadex stores its
run ID. Successful runner completion changes the wait to `resumed`.

An external process boundary cannot provide a true atomic transaction between
the Roadex state file and Codex process acceptance. If Roadex restarts after
reserving dispatch but before it can prove acceptance, it must not retry
blindly. The wait becomes `resume-reconciliation-required`, the UI reports that
approval remains valid but automatic delivery is ambiguous, and an authorized
operator must reconcile the exact continuation ID. This fail-closed state
prevents duplicate continuation effects.

### Non-approved decision

`changes-requested`, `rejected`, `expired`, and `revoked` are terminal for the
current wait. Roadex emits the authoritative outcome as a system event, clears
the active waiting projection, and returns the session lifecycle to `ready`.
It does not dispatch a continuation. The user may then submit a new prompt to
revise, abandon, or create a successor approval request.

### Security failure

Identity, project, workspace, resource, authority-class, decision-version, or
safe-navigation mismatch changes the wait to `security-failure`. Roadex leaves
the session paused, emits only a redacted failure message, records a denied
security audit event, and performs no automatic retry or continuation.

### Closed session

Closing or archiving a waiting session changes the wait to `session-closed` and
suppresses dispatch. Reopening revalidates the provider record and every scope
binding. A still-pending decision creates a successor wait; an approved
decision creates a new queued continuation with a new continuation ID. Roadex
never reuses the closed wait as executable authority.

## User Experience

Pending approval appears in both the transcript and session header. The
transcript card uses the following copy for an admin-console wait:

```text
Human approval required
This thread is safely paused.
Approve <subject> in the Admin Console.
Roadex will continue automatically after approval is verified.
Approval reference: <approvalRef>
```

For project/workflow approvals, `Admin Console` is replaced with
`Overview Console`. If a safe navigation path is configured, the card includes
`Open Admin Console` or `Open Overview Console`. The action is a normal link;
it never performs approval.

The prompt editor is disabled only while the active wait is pending,
verification-delayed, security-failure, queued, dispatching, or awaiting
reconciliation. Reconnect and bootstrap reconstruct the card from server
state, rather than relying on browser memory.

Approved waits display `Approval granted - resuming automatically`. Queued
waits add `Waiting for runner capacity`. Reconciliation-required waits state
that approval remains recorded but an operator must verify whether the exact
continuation was accepted.

Non-approved outcomes appear as ordinary system events and do not leave the
editor disabled.

## Auditing

Add dedicated audit actions for:

- `approval_wait.register`
- `approval_wait.status`
- `approval_wait.security_failure`
- `approval_wait.resume_queued`
- `approval_wait.resume_dispatched`
- `approval_wait.resume_completed`
- `approval_wait.reconciliation_required`

Audit summaries contain only safe IDs, normalized state, console surface, and
redacted subject. They never contain approval bodies, credentials, raw URLs,
provider exceptions, continuation prompts, or unrelated queue records.

## Testing Strategy

### Contract tests

- Accept one exact pending approval bound to the current controlled session.
- Reject arbitrary URLs, caller-selected console surfaces, continuation text,
  credentials, unknown fields, unsupported providers, malformed references,
  and cross-workspace records.
- Reject a second active wait for the same session.

### State-machine tests

- Cover every `ApprovalWaitState` transition.
- Prove acknowledgment, delivery, staging, claim, health, and
  `waiting_human_approval` do not resume a thread.
- Prove only `approved` queues a continuation.
- Prove every non-approved terminal result emits an outcome without dispatch.
- Prove provider failure and security mismatch fail closed.

### Persistence and restart tests

- Reconstruct a pending card after service restart.
- Recover a delayed provider check without duplicating the wait.
- Retain an approved queued continuation while runner capacity is exhausted.
- Convert an ambiguous reserved dispatch to
  `resume-reconciliation-required` rather than dispatching twice.
- Suppress a continuation for a closed session and require fresh
  revalidation after reopen.

### UI tests

- Render admin-console and overview-console cards on desktop, tablet, and
  mobile layouts.
- Disable prompt submission while an active wait can still auto-resume.
- Restore the card after reconnect.
- Show provider delay, security failure, queued resume, dispatch, and
  reconciliation states.
- Re-enable the editor after non-approved terminal outcomes.

### Integration tests

- Exercise the real provider adapter contract using a DonutHole-shaped
  provisioning fixture without creating production approvals or provisioning
  resources.
- Run a harmless controlled approval smoke that pauses a managed test thread,
  survives browser disconnect, observes a human approval through the correct
  console, and resumes the same thread.
- Correlate the continuation ID, approval reference, provider decision version,
  Roadex audit events, runner run ID, and final managed thread output.

## A-Team Responsibilities

- Hannibal owns delivery sequencing, scope control, and acceptance evidence.
- B.A. owns the persisted state machine, provider adapter, coordinator, MCP
  registration contract, and continuation dispatcher.
- Face owns the session projection, transcript card, session-header indicator,
  responsive behavior, and accessibility.
- Stockwell owns threat modeling, authority boundaries, audit redaction,
  fail-closed behavior, and security signoff.
- Murdock owns contract, state-machine, restart, UI, integration, and live-smoke
  verification.

Implementation does not begin until these assignments are recorded in the
approved Roadex A-Team plan.

## Acceptance Criteria

- A future controlled Roadex project can register one exact human-approval wait
  through the narrow MCP contract.
- Roadex persists the wait and clearly names the admin or overview console from
  server-owned authority metadata.
- The browser may disconnect without preventing approval observation or queued
  continuation.
- Only a verified authoritative `approved` decision can queue automatic
  continuation.
- The continuation runs in the same managed thread and is bound to the exact
  approval reference and decision version.
- Repeated checks and reconnects do not produce duplicate automatic dispatch.
- Ambiguous crash recovery fails closed for operator reconciliation instead of
  risking duplicate execution.
- Non-approved outcomes are reported without automatic continuation.
- Focused tests, the full test suite, lint, production build, responsive browser
  evidence, restart evidence, and A-Team security review all pass.
