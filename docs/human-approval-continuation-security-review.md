# Human Approval Continuation Security Review

Date: 2026-08-02

Reviewer: Stockwell (`roadex-security-architect`)

Reviewed Roadex head: `dcaf56c` with continuation commits through `6692106`
Reviewed Overseer feature head: `d2eae2e` in `.worktrees/roadex-approval-status`

## Decision

**The source security review passes.** The completed token-file repair closes I-1, and the reviewed authority chain now satisfies the approved caller, credential, socket, provider, UI, and continuation boundaries without an unresolved Critical, Important, or Minor security finding.

- Unresolved Critical findings: **0**
- Unresolved Important findings: **0**
- Unresolved Minor findings: **0**

This security result does not by itself complete Task 7's independent verification or authorize deployment. The unrelated selected-suite timeout and host-I/O-blocked lint evidence remain verification/handoff matters, and deployment, restart, or protected live smoke remains separately approval-gated.

## Important finding

### I-1: Overseer status bearer credential was read from process environment instead of an owner-only token file

Status: **Resolved by the token-file repair and re-review**

Original severity: **Important**

The approved plan requires the loopback Overseer API token to be read from a configured owner-only file and never logged or persisted (`docs/superpowers/plans/2026-08-02-human-approval-continuation.md:17-20`). The original implementation returned `ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN` directly from `process.env`; that production fallback has been removed.

Production startup now imports `createApprovalStatusTokenReader`, uses it as the default reader factory, and supplies its closure to the provider (`server/index.ts:66`, `server/index.ts:137-148`). The only production configuration key is `ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE`; source inspection and a regression assertion reject a direct-token fallback (`src/server/approvalTokenFile.ts:11-29`; `tests/serverRuntime.test.ts:381-410`). The dependency-injected reader remains only a testability seam and is not caller- or HTTP-reachable.

The reader validates an absolute configured path and a supported effective UID at construction. Each provider request invokes the returned closure, which reopens the file with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, validates an owner-owned regular file with exact mode `0600` and size 32-256 bytes, performs one bounded positional read, requires the exact byte count and bounded bearer grammar, closes the descriptor in `finally`, and maps every failure to only `approval_status_token_file_invalid` (`src/server/approvalTokenFile.ts:4-69`). Reopening for every call observes safe in-place rotation and deletion without a restart.

Closure evidence:

- `tests/approvalTokenFile.test.ts:34-129` proves per-call reopen, rotation, deletion, missing/empty/relative paths, no-follow symlink rejection, non-regular rejection, wrong UID, non-`0600` modes, undersized/oversized/malformed contents, and path/token redaction.
- `O_NONBLOCK` plus `metadata.isFile()` makes FIFO, directory, and device inputs fail without blocking; exact `bytesRead === metadata.size` makes concurrent truncation/short reads fail (`src/server/approvalTokenFile.ts:31-64`).
- `tests/serverRuntime.test.ts:94-160` supplies both the configured token file and a legacy direct-token sentinel, proves the file value is used, and proves token and path are absent from runtime and persisted state.
- `tests/serverRuntime.test.ts:381-410` proves a legacy direct-token-only configuration fails startup before HTTP and statically asserts the production runtime contains no direct-token environment lookup.
- The existing provider tests continue to prove per-request token acquisition, fixed loopback/exact GET, timeout, redirect, size, strict projection, scope mismatch, and upstream error redaction.
- Re-review execution passed all three directly relevant files: **3 files, 57 tests, 0 failures**.

## Authority-chain review

### Controlled thread to one-tool MCP

Pass. The runner only injects the approval workflow MCP for an exact server-authorized controlled run. The MCP exposes only `await_human_approval`, and its caller-controlled schema contains exactly `provider: "overseer"` plus a bounded opaque `approvalRef` (`src/server/approvalWorkflowMcp.ts:19-25`, `src/server/approvalWorkflowMcp.ts:59-81`; `src/server/runnerCapabilityProfile.ts`; `src/server/codexRunner.ts`). The caller cannot provide a decision, console surface/path, continuation text, user, session, project, workspace, resource, managed thread, or runner identity.

The workflow token file is constrained to the fixed owner-only directory, opened with `O_NOFOLLOW`, checked as an owner-owned `0600` regular file, bounded, read once, and unlinked (`src/server/approvalWorkflowMcp.ts:188-225`). The generated token is passed by file path rather than token value in Codex arguments (`src/server/codexRunner.ts`; `tests/codexRunner.test.ts`).

### Unix socket, peer, replay, and scope

Pass. The host binds only the fixed Unix socket, caps the request at 4096 bytes, requires one complete newline-delimited object with exact keys, verifies the peer, and returns bounded stable result codes (`src/server/approvalWorkflowHost.ts:18-68`, `src/server/approvalWorkflowHost.ts:73-165`, `src/server/approvalWorkflowHost.ts:248-300`). The grant broker creates a 256-bit random token, stores only its SHA-256 digest, expires it after five minutes, consumes it before coordinator registration, and revokes by run (`src/server/approvalWorkflowGrantBroker.ts:1-103`). Replay therefore fails even if registration later fails.

The host resolves the active server-held capability by `runId` and checks user, session, workspace, and managed thread against the consumed grant before registration (`src/server/approvalWorkflowHost.ts:168-204`). Project and resource are not caller inputs: they remain in the resolved capability and are revalidated by the coordinator/provider. Wrong peer, expired/replayed/malformed token, inactive run, binding drift, unknown request keys, trailing frames, and malformed host output fail closed in the focused tests.

### Coordinator and exact Overseer read

Pass. Registration accepts only the fixed provider and approval reference, derives identity/scope from the server-held session capability, fetches the exact status, and revalidates approval reference, project, workspace, resource, authority, subject, digest, and decision version before state transitions (`src/server/approvalCoordinator.ts`; `src/server/approvalStatusProvider.ts:71-150`). Provider I/O is fixed to `http://127.0.0.1:8766`, one percent-encoded `/roadex/approval-status?approval_ref=<exact>` GET, bearer authorization sourced through the repaired owner-only file reader, no cache, redirect rejection, five-second timeout, and a 32 KiB strict UTF-8/JSON response bound (`src/server/approvalStatusProvider.ts:37-43`, `src/server/approvalStatusProvider.ts:101-113`, `src/server/approvalStatusProvider.ts:227-324`; `src/server/approvalTokenFile.ts`). Strict own-field parsing and constant-time scope comparisons reject malformed output and scope drift. Outage, timeout, token-file failure, non-2xx, redirect, size mismatch, invalid UTF-8/JSON, extra/missing fields, and unsupported decisions fail closed with stable error codes.

No broad dispatcher is reachable from this chain. No approval-create, approval-decide, binding-write, list, execution, or provisioning method exists in `ApprovalStatusProvider`; source inspection and `tests/approvalStatusProvider.test.ts` confirm only the exact read path.

### Overseer producer binding and GET

Pass. The reviewed Overseer implementation is isolated in `/home/god/Documents/Codex Workspace/Overseer/.worktrees/roadex-approval-status` at head `d2eae2e`.

`stage_bound_roadex_approval` validates the complete draft, opens one SQLite transaction, rejects any pre-existing unbound source, creates the source, validates its initial state, derives the evidence/scope digest, and saves the immutable binding in the same transaction (`src/overseer/roadex_approval_status.py:322-368`; `src/overseer/store.py:867-887`). Identical replay is idempotent; changed fields are rejected. Source-save failure rolls back source and binding. Legacy unbound approvals fail closed and cannot be backfilled by the producer helper (`tests/test_roadex_approval_status.py:278-292`, `tests/test_roadex_approval_status.py:348-405`, `tests/test_roadex_approval_status.py:408-468`, `tests/test_roadex_approval_status.py:706-736`, `tests/test_roadex_approval_status.py:1106-1146`).

The API authenticates before routing and the new route accepts exactly one non-empty `approval_ref` query value (`src/overseer/api.py:312-340`, `src/overseer/api.py:652-663`, `src/overseer/api.py:1132-1151`). The handler loads only the exact binding and exact bound source, validates source evidence and scope digest, derives the decision, and returns the fixed 11-field public projection (`src/overseer/roadex_approval_status.py:391-426`, `src/overseer/roadex_approval_status.py:653-687`, `src/overseer/roadex_approval_status.py:730-793`). It exposes no raw plan, path, command, reason, credential, error, or body (`tests/test_roadex_approval_status.py:1876-1910`). GET mutation regression tests compare the database before and after the call (`tests/test_ui_regression.py:811-850`), including an absent binding table for legacy data (`tests/test_ui_regression.py:507-544`). No GET sibling can bind, rewrite, list, decide, execute, or accept caller scope.

### UI and console navigation

Pass. The session projection is server-derived. UI event handling triggers a canonical session refresh rather than deriving authority from assistant prose. The approval card renders state and an opaque reference, and its only action is navigation. Console paths are accepted only when the server enum and exact allowlisted path agree: `/Overseer/admin` for `admin`, `/Overseer/overview` for `overview` (`src/components/approvalWait.ts:62-68`; `src/components/ApprovalWaitCard.tsx:8-31`; `src/hooks/useRoadexSession.ts`; `src/client/sessionApi.ts`; `src/App.tsx`). No approval mutation is performed by the Roadex card.

### Continuation runner, crash handling, and idempotency

Pass. Continuation text is built only by the server from the bounded approval reference and exact SHA-256 decision version; it is a fixed five-line instruction and cannot be supplied by the caller (`src/server/approvalContinuation.ts:3-35`). The dispatcher requires the same live wait object, paused session, exact user/project/workspace/thread/public projection, canonical prompt, no runner ID, and no duplicate active continuation before starting (`src/server/sessionService.ts:473-582`). Completion must return the exact runner run ID, continuation ID, and observed managed thread before the wait becomes resumed (`src/server/sessionService.ts:915-989`; `src/server/approvalCoordinator.ts`).

Before queueing, the coordinator durably records `resume-dispatching`. A thrown, malformed, hostile, or ambiguous dispatch result becomes `resume-reconciliation-required`, not a retry. On recovery, a dispatch reservation without a provable runner acknowledgment also becomes reconciliation-required; queued work is retried only through the exact per-wait dispatcher (`src/server/approvalCoordinator.ts:471-491`, `src/server/approvalCoordinator.ts:900-1064`, `src/server/approvalCoordinator.ts:1066-1098`). Active continuation identity and terminal completion are idempotent, so uncertainty cannot produce a second continuation.

### Redaction

Pass. Approval-path errors use stable bounded codes/copy, provider errors discard upstream text, MCP/host results are allowlisted and bounded, coordinator audit summaries contain only approved metadata, and audit output redacts bearer/OpenAI-key patterns (`src/server/approvalStatusProvider.ts`; `src/server/approvalWorkflowMcp.ts`; `src/server/approvalWorkflowHost.ts`; `src/server/approvalCoordinator.ts`; `src/server/auditLog.ts:19-43`). Focused tests include secret sentinels across token, fetch, parser, MCP, runner arguments, state, and audit paths.

## Files inspected

Roadex:

- `docs/superpowers/specs/2026-08-02-human-approval-continuation-design.md`
- `docs/superpowers/plans/2026-08-02-human-approval-continuation.md`
- `.superpowers/sdd/progress.md`, task briefs, and prior independent review reports for Tasks 4-6
- `src/shared/approvalWorkflowContracts.ts`
- `src/server/approvalContinuation.ts`
- `src/server/approvalStatusProvider.ts`
- `src/server/approvalTokenFile.ts`
- `src/server/approvalCoordinator.ts`
- `src/server/approvalWorkflowGrantBroker.ts`
- `src/server/approvalWorkflowHost.ts`
- `src/server/approvalWorkflowMcp.ts`
- `src/server/controlledOperationsPeer.ts`
- `src/server/runnerCapabilityProfile.ts`
- `src/server/codexRunner.ts`
- `src/server/sessionService.ts`
- `src/server/statePersistence.ts`
- `src/server/auditLog.ts`
- `server/index.ts`
- `src/components/approvalWait.ts`
- `src/components/ApprovalWaitCard.tsx`
- `src/hooks/useRoadexSession.ts`
- `src/client/sessionApi.ts`
- `src/App.tsx`
- focused tests named below
- `tests/approvalTokenFile.test.ts`
- repaired token-file/runtime sections of `tests/serverRuntime.test.ts`

Overseer feature worktree:

- `src/overseer/roadex_approval_status.py`
- relevant binding transaction/load/save sections of `src/overseer/store.py`
- relevant authentication and exact GET sections of `src/overseer/api.py`
- `tests/test_roadex_approval_status.py`
- Roadex status route sections of `tests/test_ui_regression.py`
- Roadex human-decision sections of `tests/test_backup_provisioning.py`

## Test evidence

Roadex command executed:

```text
npm test -- --run tests/approvalStatusProvider.test.ts tests/approvalCoordinator.test.ts tests/approvalWorkflowGrantBroker.test.ts tests/approvalWorkflowHost.test.ts tests/approvalWorkflowMcp.test.ts tests/runnerCapabilityProfile.test.ts tests/codexRunner.test.ts tests/approvalLifecycleIntegration.test.ts tests/statePersistence.test.ts tests/approvalWait.test.tsx tests/sessionService.test.ts tests/runtimeApprovalBootstrap.test.ts
```

Result: **10 files passed, 237 tests passed, 0 failed**. Vitest ignored nonexistent requested names (`tests/approvalWait.test.tsx` and `tests/runtimeApprovalBootstrap.test.ts`); the actual UI/runtime files inspected are `tests/humanApprovalUi.test.tsx` and `tests/serverRuntime.test.ts`.

Additional Roadex tests inspected:

- `tests/approvalWorkflowContracts.test.ts`
- `tests/humanApprovalUi.test.tsx`
- `tests/serverRuntime.test.ts`
- `tests/sessionService.test.ts`
- `tests/runnerCapabilityProfile.test.ts`
- `tests/codexRunner.test.ts`

Token-file repair handoff evidence reported **2 files, 25 tests passed**, with TypeScript checking, build, and diff checks passed; lint could not complete because its configured host-I/O dependency was blocked. Stockwell independently reran the reader, runtime, and provider boundary together:

```text
npm test -- tests/approvalTokenFile.test.ts tests/serverRuntime.test.ts tests/approvalStatusProvider.test.ts
```

Result: **3 files passed, 57 tests passed, 0 failed**.

Overseer command executed with the available interpreter (`python3`; `python` is not installed):

```text
python3 -m pytest -q tests/test_roadex_approval_status.py tests/test_ui_regression.py tests/test_backup_provisioning.py
```

Result: **180 passed, 1 failed**. The single failure is a repeatable five-second timeout in the unrelated broad panel-matrix test `tests/test_ui_regression.py::ProtectedGatewayUiRegressionTests::test_gateway_prefix_exposes_authenticated_panel_matrix`; rerunning that test alone produced the same timeout. It does not traverse `/roadex/approval-status`, but it means the full selected-file quality gate is not green and must be handled by Task 7 verification.

The feature-focused Overseer subset was then executed:

```text
python3 -m pytest -q tests/test_roadex_approval_status.py tests/test_ui_regression.py tests/test_backup_provisioning.py -k roadex
```

Result: **153 passed, 28 deselected, 0 failed**.

## Deployment boundary

This document is a source and local-test security review only. It does **not** authorize or perform a service deployment, build-artifact installation, service or gateway restart, live listener/socket creation, token-file creation or rotation, protected-gateway change, firewall/IDS change, live state read, real approval decision, approval mutation, provisioning operation, execution, or protected live smoke.

I-1 is closed at source-review scope. A separate explicit deployment plan and approval are still required. That later plan must provision the real owner-owned `0600` token file and configure only `ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE`; this review neither creates that file nor validates live service configuration.
