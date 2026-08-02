# Human-Approval Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every controlled Roadex project a durable, clearly presented human-approval wait that automatically resumes the same managed thread only after an exact authoritative approval.

**Architecture:** A session-bound Roadex MCP tool registers an exact Overseer approval reference through a token-protected Unix socket. Roadex persists a normalized wait, checks the authoritative local Overseer API from a durable coordinator, projects a safe admin/overview console state to the browser, and dispatches a fixed internal continuation to the same managed Codex thread after approval.

**Tech Stack:** TypeScript, Node.js, React, MCP SDK, Zod, JSON state persistence, Unix domain sockets, Vitest, Playwright, Vite.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-08-02-human-approval-continuation-design.md`.
- The live approved A-Team is `ep2qSVAScvWh`: B.A. owns backend source, Face owns UI source, Stockwell owns security review, and Murdock owns independent verification.
- Source-code production must use the A-Team coding policy: `gpt-5.3-codex-spark` for B.A. and Face, with `gpt-5.6` reserved for architecture, security, troubleshooting, and review.
- Follow strict red-green-refactor. No production behavior is added before its focused test fails for the expected reason.
- Roadex may observe approval state but cannot create, change, infer, dispatch, or grant approval.
- Never parse assistant prose, accept a caller-supplied URL or continuation, scan or dispatch a broad queue, or treat acknowledgment, staging, claim, health, or `waiting_human_approval` as approval.
- Use only the loopback Overseer API at `http://127.0.0.1:8766`; read its token from a configured owner-only file and never log or persist it.
- The workflow MCP uses an owner-only Unix socket and a single-run token file. It opens no TCP listener.
- Preserve all pre-existing app-publication changes. In particular, `server/index.ts`, `src/client/sessionApi.ts`, `src/server/overseerMcp.ts`, `src/server/runnerCapabilityProfile.ts`, and their tests are already modified by another slice.
- Before every commit, inspect `git diff --cached`. If a shared file would stage a pre-existing hunk, do not commit that file; leave the task verified but uncommitted and report the overlap.
- Source and local tests do not authorize service restart, deployment, live approval mutation, provisioning, gateway changes, firewall or IDS changes, or the protected live smoke.

## Approved Overseer Compatibility Boundary

The user approved the limited source expansion needed to close the scope gap:
an immutable Roadex binding created inside an approval producer's original
staging transaction, plus one authenticated exact read-only status projection.
The contract is defined under `Overseer Exact Scope Projection` in the approved
specification.

This expansion is fail-closed and source-only. It creates no binding-rewrite,
approval, execution, dispatch, list, migration, or backfill route. Legacy
unbound approvals remain valid in Overseer but cannot resume Roadex. Task 0 may
change the Overseer checkout and run local tests; it may not rebuild, restart,
deploy, edit the live database, stage a plan, or make a human decision.

## File Map

- `/home/god/.local/share/overseer/project/src/overseer/roadex_approval_status.py`: immutable binding, canonical digests, exact source resolver, and redacted projection.
- `/home/god/.local/share/overseer/project/src/overseer/store.py`: binding table plus immutable exact load/save methods.
- `/home/god/.local/share/overseer/project/src/overseer/api.py`: authenticated exact GET route only.
- `/home/god/.local/share/overseer/project/tests/test_roadex_approval_status.py`: store, transaction, legacy, decision, and redaction tests.
- `/home/god/.local/share/overseer/project/tests/test_ui_regression.py`: protected-prefix API contract test.
- `src/shared/approvalWorkflowContracts.ts`: approval provider, wait, public projection, and MCP result contracts.
- `src/server/approvalStatusProvider.ts`: read-only normalized Overseer API adapter.
- `src/server/approvalCoordinator.ts`: registration validation, polling, state transitions, and durable scheduling.
- `src/server/approvalWorkflowGrantBroker.ts`: short-lived session/run-bound registration grants.
- `src/server/approvalWorkflowHost.ts`: owner-only Unix socket request boundary inside Roadex.
- `src/server/approvalWorkflowMcp.ts`: single-tool stdio MCP client for controlled Codex runs.
- `src/server/approvalContinuation.ts`: fixed continuation text and internal dispatch result contract.
- `src/shared/sessionContracts.ts`: safe waiting summary and audit action additions.
- `src/server/statePersistence.ts`: sanitized and retained approval-wait persistence.
- `src/server/sessionService.ts`: wait projection, user-prompt gate, and internal continuation runner path.
- `src/server/codexRunner.ts`: workflow token-file injection and continuation ID plumbing.
- `src/server/runnerCapabilityProfile.ts`: bounded `roadex-workflow` MCP configuration.
- `server/index.ts`: coordinator, Unix host, startup recovery, timer, and shutdown wiring.
- `src/hooks/useRoadexSession.ts`: reconnect-safe waiting state and composer gating.
- `src/App.tsx`: header indicator and transcript approval card.
- `src/styles.css`: accessible responsive approval presentation.
- `tests/approval*.test.ts`: focused contracts, provider, coordinator, host, MCP, and continuation tests.
- `tests/statePersistence.test.ts`, `tests/sessionService.test.ts`, `tests/codexRunner.test.ts`, `tests/runnerCapabilityProfile.test.ts`: integration regressions.
- `tests/humanApprovalUi.test.tsx` and `tests/mobile/mobile-chat.e2e.ts`: UI and responsive checks.

---

### Task 0: Add Overseer's exact Roadex approval projection

**A-Team owners:** B.A. (`tG0dAPVm9r`) for source and Stockwell
(`roadex-security-architect`) for the authority-boundary review

**Files:**
- Create: `/home/god/.local/share/overseer/project/src/overseer/roadex_approval_status.py`
- Modify: `/home/god/.local/share/overseer/project/src/overseer/store.py`
- Modify: `/home/god/.local/share/overseer/project/src/overseer/api.py`
- Create: `/home/god/.local/share/overseer/project/tests/test_roadex_approval_status.py`
- Modify: `/home/god/.local/share/overseer/project/tests/test_ui_regression.py`

**Interfaces:**
- Consumes: exact stored `AdminChangePlan` or `DonutHoleBackupProvisioningPlan` records and an internal trusted producer callback that first persists the source record.
- Produces: `stage_bound_roadex_approval(store, draft, save_source) -> RoadexApprovalBinding` and `roadex_approval_status(store_path, approval_ref) -> Mapping[str, object]`.
- HTTP: authenticated `GET /roadex/approval-status?approval_ref=<exact opaque reference>`; no body and no mutation sibling.

- [ ] **Step 1: Write failing immutable-binding and projection tests**

```python
def test_bound_source_and_scope_are_one_transaction(tmp_path):
    with SQLiteStore(tmp_path / "state.sqlite3") as store:
        binding = stage_bound_roadex_approval(
            store,
            RoadexApprovalBindingDraft(
                approval_ref="admin.roadex.test",
                source_kind="admin-plan",
                source_id="admin.roadex.test",
                project_id="project.test",
                workspace_id="workspace.test",
                resource_ref="service.test",
                authority_class="privileged-operation",
                subject="Restart test service",
            ),
            lambda: store.save_admin_change_plan(
                plan_user_service_restart(
                    "admin.roadex.test",
                    "roadex-test.service",
                    "Approval projection fixture",
                )
            ),
        )
        assert store.load_roadex_approval_binding(binding.approval_ref) == binding
        assert binding.scope_digest.startswith("sha256:")


def test_legacy_unbound_source_fails_closed(tmp_path):
    path = tmp_path / "state.sqlite3"
    with SQLiteStore(path) as store:
        store.save_admin_change_plan(
            plan_user_service_restart(
                "admin.legacy",
                "roadex-test.service",
                "Legacy approval fixture",
            )
        )
    with pytest.raises(KeyError, match="bound Roadex approval"):
        roadex_approval_status(str(path), "admin.legacy")
```

Add tests proving identical replay is idempotent, any changed binding field is
rejected, a source-save exception rolls back the binding, a binding-save
exception rolls back the source, tampered source evidence fails closed, all
decision mappings are deterministic, only one exact record is returned, and
paths, commands, reasons, credentials, approval bodies, and raw exceptions are
absent.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run from `/home/god/.local/share/overseer/project`:
`python -m pytest -q tests/test_roadex_approval_status.py`

Expected: FAIL because `roadex_approval_status` and its store table do not
exist.

- [ ] **Step 3: Add the immutable store record and transaction helper**

```python
@dataclass(frozen=True)
class RoadexApprovalBindingDraft:
    approval_ref: str
    source_kind: Literal["admin-plan", "roadex-human-decision"]
    source_id: str
    project_id: str
    workspace_id: str
    resource_ref: str
    authority_class: Literal["privileged-operation", "project-workflow"]
    subject: str


@dataclass(frozen=True)
class RoadexApprovalBinding:
    approval_ref: str
    source_kind: Literal["admin-plan", "roadex-human-decision"]
    source_id: str
    project_id: str
    workspace_id: str
    resource_ref: str
    authority_class: Literal["privileged-operation", "project-workflow"]
    subject: str
    scope_digest: str
    created_at: str


def stage_bound_roadex_approval(store, draft, save_source):
    with store.agent_transaction():
        save_source()
        source_digest = exact_source_evidence_digest(store, draft.source_kind, draft.source_id)
        binding = binding_from_draft(draft, source_digest)
        store.save_roadex_approval_binding(binding)
    return binding
```

Create `roadex_approval_bindings` with `approval_ref TEXT PRIMARY KEY`, indexed
`source_kind`, indexed `source_id`, and `payload TEXT NOT NULL`. The save method
must compare canonical payloads: identical replay returns without writing and
any difference raises `ValueError("Roadex approval binding is immutable")`.
It must call `_commit_agent_mutation()` so the existing nested transaction
mechanism supplies atomic commit and rollback.

Compute `scope_digest` from canonical compact sorted JSON containing every
scope field plus the exact source evidence digest, exactly as specified. The
producer supplies no digest. Do not add an API that invokes the transaction
helper; only trusted source producers may call it while first staging a new
source record.

- [ ] **Step 4: Implement exact source resolution and decision projection**

```python
def roadex_approval_status(store_path: str, approval_ref: str) -> Mapping[str, object]:
    validate_opaque_ref(approval_ref)
    with SQLiteStore(store_path) as store:
        binding = store.load_roadex_approval_binding(approval_ref)
        source = load_exact_bound_source(store, binding)
        source_digest = source_evidence_digest(source)
        verify_scope_digest(binding, source_digest)
        decision, updated_at, decision_version = project_decision(binding, source)
    return public_projection(binding, decision, decision_version, updated_at)
```

For `admin-plan`, require `source_id == approval_ref`; canceled maps to
`rejected`, approved maps to `approved`, and otherwise maps to `pending`. For
`roadex-human-decision`, require the exact provisioning plan and map `staged`
to `pending`, `denied` to `rejected`, `revision_requested` to
`changes-requested`, and approval/execution terminal states to `approved`.
Derive `decision_version` from canonical `(approvalRef, scopeDigest, decision,
source status, updatedAt)` data. Return only the response fields in the spec.

- [ ] **Step 5: Add the authenticated exact GET route**

In `do_GET`, after the existing authorization check, handle only:

```python
if path == "/roadex/approval-status":
    approval_refs = query.get("approval_ref", [])
    if len(approval_refs) != 1 or not approval_refs[0]:
        self._write_json({"error": "approval_ref_required"}, HTTPStatus.BAD_REQUEST)
        return
    approval_ref = approval_refs[0]
    self._handle(lambda: roadex_approval_status(store_path, approval_ref))
    return
```

Add API tests for the direct and protected-prefix paths, missing and duplicate
query values, unauthorized access, exact success, legacy unbound not-found,
and no state change before/after GET. Do not add a POST, PATCH, DELETE, list,
wildcard, or search route.

- [ ] **Step 6: Run focused and adjacent Overseer tests**

Run from `/home/god/.local/share/overseer/project`:

```bash
python -m pytest -q tests/test_roadex_approval_status.py tests/test_ui_regression.py tests/test_backup_provisioning.py
```

Expected: all selected tests pass and the live state file is never opened.

- [ ] **Step 7: Review and commit only the Overseer source slice**

```bash
git status --short
git add src/overseer/roadex_approval_status.py src/overseer/store.py src/overseer/api.py tests/test_roadex_approval_status.py tests/test_ui_regression.py
git diff --cached --check
git diff --cached
git commit -m "Add exact Roadex approval status projection"
```

Preserve the unrelated untracked OPNsense approval document. Stop after the
commit: no install, service action, database migration, or live request is part
of this task.

---

### Task 1: Define and persist approval-wait contracts

**A-Team owner:** B.A. (`tG0dAPVm9r`)

**Files:**
- Create: `src/shared/approvalWorkflowContracts.ts`
- Modify: `src/shared/sessionContracts.ts:8-68`
- Modify: `src/server/statePersistence.ts:1-220`
- Test: `tests/statePersistence.test.ts`
- Test: `tests/approvalWorkflowContracts.test.ts`

**Interfaces:**
- Consumes: existing `RoadexSession`, `StatePersistence`, and JSON state serialization.
- Produces: `ApprovalWaitRecord`, `WaitingApprovalSummary`, `NormalizedApprovalStatus`, `ApprovalWaitState`, `ApprovalConsoleSurface`, and persisted `approvalWaits`.

- [ ] **Step 1: Write failing contract and persistence tests**

```ts
import { describe, expect, it } from 'vitest';
import { consoleForAuthority, isActiveApprovalWait } from '../src/shared/approvalWorkflowContracts';

describe('approval workflow contracts', () => {
  it('maps authority to a server-owned console surface', () => {
    expect(consoleForAuthority('privileged-operation')).toBe('admin');
    expect(consoleForAuthority('project-workflow')).toBe('overview');
  });

  it('keeps only executable wait states active', () => {
    expect(isActiveApprovalWait('pending')).toBe(true);
    expect(isActiveApprovalWait('resume-reconciliation-required')).toBe(true);
    expect(isActiveApprovalWait('rejected')).toBe(false);
    expect(isActiveApprovalWait('resumed')).toBe(false);
  });
});
```

Add a `tests/statePersistence.test.ts` case that serializes a valid wait and an invalid wait with an absolute `consolePath`; assert that only the valid record remains and that a persisted `streaming` session still normalizes independently.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- tests/approvalWorkflowContracts.test.ts tests/statePersistence.test.ts`

Expected: FAIL because `approvalWorkflowContracts.ts` and `approvalWaits` do not exist.

- [ ] **Step 3: Add the exact shared types and helpers**

```ts
export type ApprovalAuthorityClass = 'privileged-operation' | 'project-workflow';
export type ApprovalConsoleSurface = 'admin' | 'overview';
export type ApprovalDecision = 'pending' | 'approved' | 'changes-requested' | 'rejected' | 'expired' | 'revoked';
export type ApprovalWaitState =
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

export const ACTIVE_APPROVAL_WAIT_STATES = new Set<ApprovalWaitState>([
  'pending',
  'verification-delayed',
  'security-failure',
  'approved-resume-queued',
  'resume-dispatching',
  'resume-reconciliation-required',
]);

export function consoleForAuthority(value: ApprovalAuthorityClass): ApprovalConsoleSurface {
  return value === 'privileged-operation' ? 'admin' : 'overview';
}

export function isActiveApprovalWait(value: ApprovalWaitState): boolean {
  return ACTIVE_APPROVAL_WAIT_STATES.has(value);
}
```

Add the full record and normalized provider types exactly as approved in the specification. Add `waitingApproval?: WaitingApprovalSummary` to `RoadexSession`, and add the seven `approval_wait.*` actions to `AuditEvent['action']`.

- [ ] **Step 4: Extend persistence with strict sanitization and retention**

Add `approvalWaits: ApprovalWaitRecord[]` to `PersistedRoadexState`, memory persistence, empty state, `sanitizeState`, `applyRetention`, and `saveState` call sites. Implement `sanitizeApprovalWait` with bounded opaque IDs, exact enums, ISO dates, non-empty managed thread identity, and a relative allowlisted `consolePath` projection only; the persisted record itself stores `consoleSurface`, never a URL.

Use `ROADEX_MAX_APPROVAL_WAITS` with a default of `500` and `ROADEX_APPROVAL_WAIT_RETENTION_MS` with a default of `2_592_000_000`. Retain all active waits and the newest terminal waits within the configured bound.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -- tests/approvalWorkflowContracts.test.ts tests/statePersistence.test.ts`

Expected: PASS with no invalid wait retained.

- [ ] **Step 6: Commit the isolated task when staging is clean**

```bash
git add src/shared/approvalWorkflowContracts.ts src/shared/sessionContracts.ts src/server/statePersistence.ts tests/approvalWorkflowContracts.test.ts tests/statePersistence.test.ts
git diff --cached --check
git diff --cached
git commit -m "Add durable approval wait contracts"
```

If the staged diff contains pre-existing changes, unstage the overlapping file and report it instead of committing another slice's work.

---

### Task 2: Normalize exact Overseer approval status

**A-Team owner:** B.A. (`tG0dAPVm9r`)

**Files:**
- Create: `src/server/approvalStatusProvider.ts`
- Test: `tests/approvalStatusProvider.test.ts`

**Interfaces:**
- Consumes: `RoadexApprovalStatusProjection`, `ApprovalDecision`, `NormalizedApprovalStatus`, loopback API base, and token-file path.
- Produces: `ApprovalStatusProvider.getStatus(approvalRef, scope)` with no mutation methods.

- [ ] **Step 1: Write failing provider tests with a fake fetch**

```ts
it('reads only the exact scoped projection', async () => {
  const provider = createOverseerApprovalStatusProvider({
    readToken: () => 'test-token',
    fetchJson: async (path) => {
      expect(path).toBe('/roadex/approval-status?approval_ref=admin.roadex.test');
      return {
        approvalRef: 'admin.roadex.test',
        sourceKind: 'admin-plan',
        projectId: 'project.test',
        workspaceId: 'workspace.test',
        resourceRef: 'service.test',
        authorityClass: 'privileged-operation',
        subject: 'Restart test service',
        scopeDigest: 'sha256:scope',
        decision: 'approved',
        decisionVersion: 'sha256:decision',
        updatedAt: '2026-08-02T18:00:00.000Z',
      };
    },
  });

  await expect(provider.getStatus('admin.roadex.test', {
    projectId: 'project.test',
    workspaceId: 'workspace.test',
    resourceRef: 'service.test',
  })).resolves.toMatchObject({
    approvalRef: 'admin.roadex.test',
    authorityClass: 'privileged-operation',
    decision: 'approved',
  });
});
```

Add cases for every decision enum, each scope field mismatch, approval-reference
mismatch, unsupported source or authority enum, malformed JSON, unexpected
fields, missing exact binding, token-read failure, timeout, oversized response,
and a provider error containing a fake secret. Assert all failures are
fail-closed and redacted.

- [ ] **Step 2: Run the provider test and confirm RED**

Run: `npm test -- tests/approvalStatusProvider.test.ts`

Expected: FAIL because `createOverseerApprovalStatusProvider` does not exist.

- [ ] **Step 3: Implement the read-only provider interface**

```ts
export type ApprovalScope = {
  projectId: string;
  workspaceId: string;
  resourceRef: string;
};

export type ApprovalStatusProvider = {
  getStatus: (approvalRef: string, scope: ApprovalScope) => Promise<NormalizedApprovalStatus>;
};

export type OverseerProviderOptions = {
  apiBase?: 'http://127.0.0.1:8766';
  readToken: () => string;
  fetchJson?: (path: string, token: string) => Promise<unknown>;
};
```

Validate `approvalRef` as a bounded opaque identifier, percent-encode it, and
call only `/roadex/approval-status?approval_ref=<exact>`. Parse the exact
response type from the approved specification; reject unknown fields and do
not derive or repair provider metadata. Compare `approvalRef`, `projectId`,
`workspaceId`, and `resourceRef` with constant-time string comparisons before
returning a normalized result. `authorityClass` determines console surface
through the shared server-owned mapping.

Treat `scopeDigest`, `decisionVersion`, and `updatedAt` as authoritative opaque
evidence after schema and scope validation. Roadex never recomputes an
Overseer decision from older list endpoints and never falls back to
`/admin/policies`, `/roadex/human-decisions`, or
`/backup-provisioning/plans`.

- [ ] **Step 4: Prove the adapter has no mutation surface**

Add a test that inspects `Object.keys(provider)` and expects only
`['getStatus']`. Assert requests use GET, the fixed loopback base,
`cache: 'no-store'`, a bounded timeout, a bounded response body, and
`Authorization: Bearer <token>` without exposing the token in thrown errors.
Assert the adapter source contains none of the approval mutation route names.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -- tests/approvalStatusProvider.test.ts`

Expected: PASS, including exact-record and redaction cases.

- [ ] **Step 6: Commit the isolated provider**

```bash
git add src/server/approvalStatusProvider.ts tests/approvalStatusProvider.test.ts
git diff --cached --check
git commit -m "Add exact approval status provider"
```

---

### Task 3: Build the durable approval coordinator

**A-Team owner:** B.A. (`tG0dAPVm9r`)

**Files:**
- Create: `src/server/approvalCoordinator.ts`
- Create: `src/server/approvalContinuation.ts`
- Test: `tests/approvalCoordinator.test.ts`

**Interfaces:**
- Consumes: `ApprovalStatusProvider`, persisted waits, current sessions, audit/event callbacks, and internal continuation queue callback.
- Produces: `ApprovalCoordinator.register`, `ApprovalCoordinator.tick`, `ApprovalCoordinator.closeSessionWait`, and fixed `buildApprovalContinuation`.

- [ ] **Step 1: Write failing registration and state-transition tests**

```ts
const coordinator = new ApprovalCoordinator({
  waits,
  sessions,
  provider,
  persist: () => persisted.push(snapshot(waits)),
  publish: (event) => events.push(event),
  audit: (action, outcome) => audits.push([action, outcome]),
  queueContinuation: async (wait, prompt) => queued.push([wait.continuationId, prompt]),
  now: () => '2026-08-02T18:00:00.000Z',
  randomId: () => 'fixed-id',
});

await coordinator.register(sessionCapability, { provider: 'overseer', approvalRef: 'admin.roadex.test' });
expect(session.lifecycle).toBe('paused');
expect(waits[0]).toMatchObject({ state: 'pending', consoleSurface: 'admin' });
expect(persisted).toHaveLength(1);
```

Add table-driven cases proving that only `approved` reaches `approved-resume-queued`, all non-approved outcomes become terminal without queueing, provider errors become `verification-delayed`, binding mismatches become `security-failure`, and a second active wait returns `active-wait-exists`.

- [ ] **Step 2: Run the coordinator test and confirm RED**

Run: `npm test -- tests/approvalCoordinator.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement registration and deterministic state changes**

```ts
export type RegisterApprovalWaitInput = {
  provider: 'overseer';
  approvalRef: string;
};

export type RegisterApprovalWaitResult =
  | { ok: true; wait: WaitingApprovalSummary }
  | { ok: false; code: 'active-wait-exists' | 'approval-not-pending' | 'scope-mismatch' | 'provider-unavailable' };
```

`register` must fetch and validate the pending record first, create a deterministic continuation ID from `(sessionId, approvalRef, decisionVersion)`, persist the wait, set the session to `paused`, persist again only when state changed, then publish the system event. Never publish before persistence succeeds.

- [ ] **Step 4: Implement bounded ticking and fail-closed dispatch**

`tick` selects only active waits whose `nextCheckAt` has passed. Use delays of `2s`, `5s`, `15s`, `30s`, then cap at `60s`; inject the clock in tests and do not use blocking sleeps. Revalidate every scope field on every result.

When approved, persist `approved-resume-queued`, call `queueContinuation`, then accept only these results:

```ts
export type ApprovalContinuationDispatchResult =
  | { status: 'started'; runnerRunId: string }
  | { status: 'capacity'; retryAt: string }
  | { status: 'ambiguous' }
  | { status: 'denied'; reason: 'session-closed' | 'thread-mismatch' | 'scope-mismatch' };
```

Map `capacity` back to queued, `started` to dispatching with the run ID, `ambiguous` to reconciliation-required, and `denied` to security-failure or session-closed as appropriate.

- [ ] **Step 5: Add fixed continuation text tests**

```ts
expect(buildApprovalContinuation(wait)).toBe([
  '[Roadex verified human approval]',
  'Approval reference: admin.roadex.test',
  'Decision version: sha256:decision',
  'Continue the previously paused workflow within the exact approved scope.',
  'Do not broaden the approved operation or infer approval for another gate.',
].join('\n'));
```

Assert that provider reason text, console paths, user prose, credentials, and project-supplied strings cannot enter the continuation.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `npm test -- tests/approvalCoordinator.test.ts`

Expected: PASS for registration, restart-safe state, non-approval, retry, and ambiguity cases.

- [ ] **Step 7: Commit the coordinator**

```bash
git add src/server/approvalCoordinator.ts src/server/approvalContinuation.ts tests/approvalCoordinator.test.ts
git diff --cached --check
git commit -m "Add durable approval coordinator"
```

---

### Task 4: Add the session-bound Roadex workflow MCP

**A-Team owner:** B.A. (`tG0dAPVm9r`)

**Files:**
- Create: `src/server/approvalWorkflowGrantBroker.ts`
- Create: `src/server/approvalWorkflowHost.ts`
- Create: `src/server/approvalWorkflowMcp.ts`
- Modify: `src/server/runnerCapabilityProfile.ts:1-47`
- Modify: `src/server/codexRunner.ts:27-196`
- Test: `tests/approvalWorkflowGrantBroker.test.ts`
- Test: `tests/approvalWorkflowHost.test.ts`
- Test: `tests/approvalWorkflowMcp.test.ts`
- Test: `tests/runnerCapabilityProfile.test.ts`
- Test: `tests/codexRunner.test.ts`

**Interfaces:**
- Consumes: current controlled-runner selection and the coordinator registration callback.
- Produces: one-time workflow token, owner-only socket request, and `roadex_workflow.await_human_approval`.

- [ ] **Step 1: Write failing grant and socket-boundary tests**

Create tests that issue one grant and assert exact user/session/workspace/managed-thread/run binding, single consumption, expiry, malformed token denial, replay denial, wrong socket peer denial, unknown field denial, and no raw token in audit or error output.

Use this exact request shape:

```ts
type ApprovalWorkflowSocketRequest = {
  token: string;
  provider: 'overseer';
  approvalRef: string;
};
```

- [ ] **Step 2: Run grant and host tests and confirm RED**

Run: `npm test -- tests/approvalWorkflowGrantBroker.test.ts tests/approvalWorkflowHost.test.ts`

Expected: FAIL because the grant broker and host do not exist.

- [ ] **Step 3: Implement a single-use bounded grant broker**

```ts
export type ApprovalWorkflowGrant = {
  token: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  managedThreadId: string;
  runId: string;
  expiresAt: string;
};

export class ApprovalWorkflowGrantBroker {
  issue(scope: Omit<ApprovalWorkflowGrant, 'token' | 'expiresAt'>): ApprovalWorkflowGrant;
  consume(token: string): ApprovalWorkflowGrant | undefined;
  revokeRun(runId: string): void;
}
```

Generate 256-bit random tokens, store only SHA-256 token digests, default expiry to five minutes, and delete the grant before invoking coordinator registration.

- [ ] **Step 4: Implement the owner-only Unix host**

Bind `/run/user/1000/roadex-approval-workflow.sock` with mode `0600`. Accept one newline-delimited JSON object with a 4096-byte cap. Require exact keys, consume the token, verify the active run and session binding, then call `coordinator.register`. Return one bounded JSON result and close. Startup must reject a non-socket path; shutdown removes only the validated socket path.

- [ ] **Step 5: Implement and test the one-tool MCP client**

```ts
server.registerTool('await_human_approval', {
  description: 'Pause this exact Roadex managed thread for one existing authoritative human approval. This tool cannot grant approval.',
  inputSchema: {
    provider: z.literal('overseer'),
    approvalRef: z.string().regex(/^(admin|roadex-human-decision)\.[A-Za-z0-9._:-]{1,220}$/),
  },
}, async ({ provider, approvalRef }) => socketResult({ token, provider, approvalRef }));
```

Read the token from `ROADEX_APPROVAL_WORKFLOW_TOKEN_FILE`, require an owner-only regular file, read it once, unlink it, and connect only to `ROADEX_APPROVAL_WORKFLOW_SOCKET` after validating the exact fixed path.

- [ ] **Step 6: Inject the MCP only into controlled runs**

Add `approvalWorkflowConfigOverrides(tokenFile)` beside `controlledOperationConfigOverrides`. It must add only `mcp_servers.roadex-workflow`, enable only `await_human_approval`, and pass only the fixed socket plus token-file paths. Extend `RunnerPromptRequest` with `approvalWorkflowToken?: string` and `runId?: string`; create and securely remove the token file using the existing controlled-token pattern.

Add tests proving restricted runs do not receive the tool, controlled runs do, malformed paths are rejected, and the token value never appears in Codex arguments.

- [ ] **Step 7: Run all focused MCP and runner tests**

Run: `npm test -- tests/approvalWorkflowGrantBroker.test.ts tests/approvalWorkflowHost.test.ts tests/approvalWorkflowMcp.test.ts tests/runnerCapabilityProfile.test.ts tests/codexRunner.test.ts`

Expected: PASS with one exposed workflow tool and no token disclosure.

- [ ] **Step 8: Commit only isolated workflow changes**

Stage new files first. Stage the already-modified runner files only after reviewing cached hunks and proving no app-publication changes are included.

```bash
git add src/server/approvalWorkflowGrantBroker.ts src/server/approvalWorkflowHost.ts src/server/approvalWorkflowMcp.ts tests/approvalWorkflowGrantBroker.test.ts tests/approvalWorkflowHost.test.ts tests/approvalWorkflowMcp.test.ts
git diff --cached --check
git commit -m "Add session bound approval workflow MCP"
```

---

### Task 5: Wire automatic continuation into Roadex lifecycle

**A-Team owner:** B.A. (`tG0dAPVm9r`)

**Files:**
- Modify: `src/server/sessionService.ts:65-115,372-530,2570-2620`
- Modify: `server/index.ts:1-82`
- Modify: `src/server/auditLog.ts`
- Test: `tests/sessionService.test.ts`
- Test: `tests/approvalLifecycleIntegration.test.ts`

**Interfaces:**
- Consumes: coordinator, provider, grant broker, workflow host, `SessionRunner.runPrompt`, and persisted waits.
- Produces: active-wait projection, typed prompt denial, internal continuation dispatch, startup recovery, and clean shutdown.

- [ ] **Step 1: Write failing user-prompt and internal-continuation tests**

Add tests proving a pending wait rejects `submitPrompt` with `human-approval-pending`, does not append a user stream event, and records a denied audit. Add a separate test invoking the internal dispatcher and asserting the runner receives the same managed thread, the fixed continuation, the deterministic continuation ID, and no user-supplied prompt.

- [ ] **Step 2: Run lifecycle tests and confirm RED**

Run: `npm test -- tests/sessionService.test.ts tests/approvalLifecycleIntegration.test.ts`

Expected: FAIL because Roadex has no active-wait gate or internal continuation API.

- [ ] **Step 3: Extract one internal run starter without changing user behavior**

Refactor the existing body of `submitPrompt` into:

```ts
type SessionRunOrigin =
  | { kind: 'user'; actor: UserProfile; prompt: string }
  | { kind: 'approval'; wait: ApprovalWaitRecord; prompt: string; continuationId: string };

function startSessionRun(
  state: RoadexState,
  session: RoadexSession,
  origin: SessionRunOrigin,
): PromptAcceptedResponse | ApprovalContinuationDispatchResult;
```

Keep existing user validation, stream events, cancellation, managed-thread mismatch handling, and controlled-operation token behavior unchanged. Approval-origin runs append a system event rather than a user event and use audit actor `roadex-approval-coordinator`.

- [ ] **Step 4: Add prompt gating and continuation completion**

Before user prompt acceptance, query the active wait map. Reject every active state. When an approval-origin run completes, notify the coordinator with `(continuationId, runnerRunId, result)` so it can persist `resumed`, `security-failure`, or reconciliation state before publishing the final event.

- [ ] **Step 5: Wire startup, scheduler, and shutdown**

In `server/index.ts`, construct the token reader, provider, grant broker, coordinator, and workflow host after `createInitialState`. Start the socket before accepting HTTP traffic. Call `coordinator.recover()` once, then run `coordinator.tick()` from an unref'd interval configured by `ROADEX_APPROVAL_POLL_MS` with a default of `2000`.

On `SIGTERM` and `SIGINT`, clear the interval, close the workflow socket, revoke outstanding grants, and then close the HTTP server. Do not restart any live service in this task.

- [ ] **Step 6: Add restart and ambiguous-dispatch tests**

Create state with pending, queued, and dispatching waits. Assert startup leaves pending scheduled, retries queued only when capacity permits, and converts dispatching without a provable runner acknowledgment to `resume-reconciliation-required` without calling the runner.

- [ ] **Step 7: Run backend integration tests and confirm GREEN**

Run: `npm test -- tests/sessionService.test.ts tests/approvalLifecycleIntegration.test.ts tests/statePersistence.test.ts tests/codexRunner.test.ts`

Expected: PASS with one continuation, exact managed-thread identity, and fail-closed recovery.

- [ ] **Step 8: Commit only after overlap review**

```bash
git add src/server/sessionService.ts src/server/auditLog.ts tests/sessionService.test.ts tests/approvalLifecycleIntegration.test.ts
git diff --cached --check
git diff --cached
git commit -m "Resume approved Roadex workflows"
```

Do not stage `server/index.ts` if its pre-existing app-publication hunks cannot be isolated safely.

---

### Task 6: Present the human gate in the responsive UI

**A-Team owner:** Face (`VAy5YIhQTa`)

**Files:**
- Modify: `src/hooks/useRoadexSession.ts:38-115,240-380,700-790`
- Modify: `src/App.tsx:540-700`
- Modify: `src/styles.css`
- Modify: `src/client/sessionApi.ts`
- Test: `tests/humanApprovalUi.test.tsx`
- Test: `tests/sessionApi.test.ts`
- Test: `tests/mobile/mobile-chat.e2e.ts`

**Interfaces:**
- Consumes: `RoadexSession.waitingApproval` and existing bootstrap/SSE refresh behavior.
- Produces: `approvalWait`, `approvalComposerBlocked`, accessible waiting card, header status, and responsive layouts.

- [ ] **Step 1: Write failing UI state tests**

Render sessions with admin and overview waits. Assert the exact headings, console names, approval reference, automatic-continuation copy, safe optional link, `role="status"`, and disabled composer. Add terminal-outcome tests proving the composer re-enables.

```tsx
expect(screen.getByRole('status', { name: /human approval required/i })).toHaveTextContent(
  'Roadex will continue automatically after approval is verified.',
);
expect(screen.getByRole('link', { name: 'Open Admin Console' })).toHaveAttribute(
  'href',
  '/Overseer/admin',
);
expect(screen.getByLabelText('Prompt')).toBeDisabled();
```

- [ ] **Step 2: Run UI tests and confirm RED**

Run: `npm test -- tests/humanApprovalUi.test.tsx tests/sessionApi.test.ts`

Expected: FAIL because no approval UI projection is rendered.

- [ ] **Step 3: Add reconnect-safe hook projection**

Derive the active wait from the selected server session on every bootstrap update; do not create browser-local approval state. Export:

```ts
approvalWait: session?.waitingApproval,
approvalComposerBlocked: Boolean(session?.waitingApproval),
```

When SSE reports a wait transition, refresh bootstrap through the existing authenticated request path. Never accept a console URL from an SSE message.

- [ ] **Step 4: Add the transcript card and header indicator**

Render this structure before transcript events:

```tsx
<section aria-label="Human approval required" className={`approval-wait ${wait.state}`} role="status">
  <div>
    <span className="section-label">Human approval required</span>
    <strong>This thread is safely paused.</strong>
  </div>
  <p>Approve {wait.subject} in the {consoleLabel}.</p>
  <p>Roadex will continue automatically after approval is verified.</p>
  <code>{wait.approvalRef}</code>
  {wait.consolePath ? <a href={wait.consolePath}>Open {consoleLabel}</a> : null}
</section>
```

Use server-projected relative paths only. Add state-specific copy for delayed verification, security failure, queued capacity, dispatching, and reconciliation. The link navigates; it performs no API mutation.

- [ ] **Step 5: Add responsive and accessibility styles**

Use the existing theme variables, a minimum 44px action target, visible focus state, wrapping code/reference text, and no color-only state distinction. On mobile, stack the content and action; on tablet and desktop, keep the action aligned without shrinking the transcript.

- [ ] **Step 6: Extend mobile E2E coverage**

Add a safe fixture bootstrap with an overview wait. Verify the card is visible, the prompt is disabled, the drawer and transcript remain usable, and reconnect preserves the card. Do not click the approval console action during automated tests.

- [ ] **Step 7: Run UI and responsive tests and confirm GREEN**

Run: `npm test -- tests/humanApprovalUi.test.tsx tests/sessionApi.test.ts`

Run: `npm run test:mobile -- --grep "human approval"`

Expected: PASS on the configured desktop/mobile component fixture and Playwright mobile viewport.

- [ ] **Step 8: Commit only isolated UI changes**

```bash
git add src/App.tsx src/hooks/useRoadexSession.ts src/styles.css tests/humanApprovalUi.test.tsx tests/mobile/mobile-chat.e2e.ts
git diff --cached --check
git commit -m "Show Roadex human approval waits"
```

Do not stage `src/client/sessionApi.ts` if its app-publication changes cannot be separated.

---

### Task 7: Security review, full verification, and deployment handoff

**A-Team owners:** Stockwell (`roadex-security-architect`) and Murdock (`mXeS8Na0gY`)

**Files:**
- Create: `docs/human-approval-continuation-security-review.md`
- Create: `docs/human-approval-continuation-verification.md`
- Modify: `docs/a-team-plan.md`
- Test: all focused and full test suites.

**Interfaces:**
- Consumes: completed Overseer projection, Roadex backend and UI implementation, plus the approved specification.
- Produces: independent security findings, complete verification evidence, and a separately approval-gated deployment plan.

- [ ] **Step 1: Run Stockwell's authority-boundary review**

Review controlled thread → MCP token file → Unix socket → Roadex coordinator → Overseer API → admin/overview console → continuation runner. Record findings by severity and verify:

- the caller cannot submit a decision, URL, continuation, identity, workspace, or thread;
- token replay, wrong peer, wrong scope, malformed provider output, and provider outage fail closed;
- no broad dispatcher or approval mutation is reachable;
- audit, UI, and errors are redacted;
- ambiguous process acceptance cannot duplicate continuation.
- the Overseer GET cannot attach/rewrite a binding, list approvals, mutate a
  decision, execute a plan, expose raw source data, or accept caller scope;
- the producer helper is atomic and only new transaction-bound approvals are
  eligible; legacy records cannot be backfilled through an API.

Resolve every critical and important finding before proceeding.

- [ ] **Step 2: Run all focused approval tests**

Run in `/home/god/.local/share/overseer/project`:

```bash
python -m pytest -q tests/test_roadex_approval_status.py tests/test_ui_regression.py tests/test_backup_provisioning.py
```

Expected: all selected Overseer tests pass without reading the live state
file.

Run in `/home/god/Documents/Codex Workspace/Roadex`:

Run: `npm test -- tests/approvalWorkflowContracts.test.ts tests/approvalStatusProvider.test.ts tests/approvalCoordinator.test.ts tests/approvalWorkflowGrantBroker.test.ts tests/approvalWorkflowHost.test.ts tests/approvalWorkflowMcp.test.ts tests/approvalLifecycleIntegration.test.ts tests/humanApprovalUi.test.tsx`

Expected: all focused files pass with zero failures.

- [ ] **Step 3: Run the full quality gate**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Run: `npm audit --audit-level=high`

Run: `git diff --check`

Expected: every command exits zero; audit reports no high or critical vulnerability.

- [ ] **Step 4: Run responsive browser verification**

Verify the admin and overview cards at desktop, tablet, and mobile sizes. Capture screenshots or review notes showing the persistent header state, readable approval reference, safe navigation action, disabled composer, reconnect recovery, and terminal non-approval behavior.

- [ ] **Step 5: Run a local harmless integration fixture**

Use a fake in-process provider and fake runner. Demonstrate pending → browser disconnect → approved → same managed thread continuation. Correlate approval reference, decision version, continuation ID, audit event, runner run ID, and terminal state. No live Overseer mutation or provisioning may occur.

- [ ] **Step 6: Prepare, but do not execute, live-smoke and deployment approval**

Document the exact build artifact, checksum, backup, feature flags, token-file path, Unix socket path, service restart command, health checks, harmless approval fixture, rollback, and evidence correlation. Route any restart or shared-service change through a separate Overseer admin plan. The plan must state that approval of source code does not authorize deployment or a real provisioning action.

- [ ] **Step 7: Update A-Team statuses after evidence exists**

Set B.A. and Face assignments to `done` only after their focused tests pass. Set Stockwell and Murdock to `done` only after independent review and full verification pass. Keep any live smoke or deployment status explicitly pending its separate approval.

- [ ] **Step 8: Commit verification documentation without unrelated work**

```bash
git add docs/human-approval-continuation-security-review.md docs/human-approval-continuation-verification.md docs/a-team-plan.md
git diff --cached --check
git commit -m "Document approval workflow verification"
```

## Plan Self-Review

- Spec coverage: registration, persistence, admin/overview routing, prompt gate,
  restart recovery, automatic same-thread continuation, non-approval behavior,
  crash ambiguity, audit, UI, responsive behavior, security, and verification
  each have an owning task. Task 0 supplies the approved immutable scope
  binding and exact projection that Task 2 consumes.
- Placeholder scan: no unresolved marker, deferred implementation note,
  generic edge-case instruction, or unresolved provider route remains.
  Code-producing steps name exact interfaces, tests, commands, and expected
  results.
- Type consistency: `ApprovalWaitRecord`, `NormalizedApprovalStatus`, `ApprovalContinuationDispatchResult`, `WaitingApprovalSummary`, and `RegisterApprovalWaitInput` are defined once and consumed under the same names in later tasks.
- Scope check: Overseer and Roadex rebuild/restart, deployment, live database
  access, protected smoke, real approval mutation, and provisioning remain
  outside source implementation and require separate approval.
- Worktree safety: existing Roadex app-publication changes and Overseer's
  unrelated untracked OPNsense approval document are preserved; overlapping
  files must not be committed without exact staged-hunk review.
- Result: the source and local-test plan is execution-ready. Deployment and
  live-smoke work remain separately gated.
