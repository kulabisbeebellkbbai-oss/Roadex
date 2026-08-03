# Human-Approval Continuation Security Review

Date: 2026-08-02

Status: **PASS — Quality APPROVED**

This is the Task 7 review record for the approved human-approval continuation
design. It is a source-review record, not a deployment approval. The final
Roadex implementation commit reviewed by Task 7 is
`08a0e3ba4dbd4c733467deff00f3527c8accf7ce`. The initial security review used
Roadex `2d8cde1` and Overseer `f345769`; the reviewed Overseer remediation is
`d2eae2e2963c51dc59d8c2aab71fd5e4ac2ea95f`. Task 5 received independent
PASS/APPROVED at `9d13f05`; Task 6 received PASS/APPROVED at `32a020d`.

## Authority Boundary Under Review

The exact path is:

1. controlled managed thread;
2. per-run token file;
3. owner-only Unix socket and peer validation;
4. Roadex workflow host and one-run grant consumption;
5. Roadex approval coordinator;
6. exact read-only Overseer approval-status projection;
7. deployment-owned Admin or Overview Console mapping;
8. fixed Roadex continuation dispatcher to the same managed thread.

The approved trust model requires the following properties:

- The controlled caller supplies only `provider: "overseer"` and one opaque
  `approvalRef`. It cannot supply a decision, URL, continuation text, user,
  project, workspace, resource, session, or managed-thread identity.
- Registration uses a short-lived, one-use, run-bound grant delivered through
  an owner-only token file and `/run/user/1000/roadex-approval-workflow.sock`.
- Token replay, a wrong peer, wrong run or scope, malformed provider output,
  provider outage, and ambiguous runner completion must fail closed.
- Roadex performs only an exact status read. No broad approval dispatcher,
  approval mutation, binding attachment or rewrite, listing, plan execution, or
  source-data read is part of this workflow.
- Overseer accepts only an exact approval reference. It derives and verifies
  immutable scope server-side and returns a bounded redacted projection.
- Only a new approval staged with its immutable binding in the producer's
  original transaction is eligible. Legacy unbound approvals are not eligible
  and cannot be backfilled through an API.
- Console navigation comes from the authority-class allowlist, never from MCP
  input or provider data. Logs, audit records, public session state, UI output,
  and errors must remain redacted.
- A verified `approved` decision may reserve one fixed continuation. Other
  terminal decisions do not continue, and ambiguous process acceptance enters
  reconciliation instead of issuing a duplicate continuation.

## Evidence Available to the Reviewer

- The exact Task 7 Roadex approval suite passed: 8 files, 137 tests.
- The combined focused implementation suites passed: 8 files, 231 tests.
- The bounded full Roadex suite passed: 48 files, 503 tests.
- Lint, server TypeScript compilation, production build, and diff checks
  passed. `npm audit` reported 0 vulnerabilities.
- `approvalLifecycleIntegration` covers a harmless local fake-provider and
  fake-runner flow: user-run registration, a persisted paused wait with no
  browser subscriber, provider approval, continuation in the exact same
  managed thread, one-run grant use, coordinator persistence before terminal
  completion, the immediate-resolve race, and shutdown.
- In the source-only Overseer worktree, the exact Roadex projection suite
  passed 133 tests, the approval-status API subset passed 10 tests, and a
  selected suite excluding one unrelated UI matrix test passed 180 tests with
  1 deselected. The isolated unrelated
  `gateway_prefix_exposes_authenticated_panel_matrix` test remains not green:
  `/Overseer/virtual/evidence` in the temporary `LocalApiHarness` exceeds its
  hard five-second timeout.
- Live Overseer health was checked read-only and returned `ok`. Projection
  tests did not use the live Overseer state file.
- The default 30-second mobile run initially exhausted its timeout during
  browser launch. A harness-only 120,000 ms timeout then reached a real pointer
  interception defect at the semantic Close navigation target. Roadex commit
  `08a0e3b` fixes the target geometry, and independent reruns passed all 14
  `humanApprovalUi` tests, lint, and the exact approval mobile E2E on Android
  Pixel 7 and iPhone 15 with `--timeout=120000`. Responsive browser verification
  for this approval workflow is PASS.

## Findings

### Initial independent review

Stockwell reviewed Roadex `2d8cde1` with Overseer `f345769`. The review found
one **Important** no-backfill gap: the producer helper did not reject a
preexisting unbound admin or Roadex source, allowing it to be retroactively
bound. The initial verdict was **FAIL / CHANGES_REQUESTED**.

### Remediation

Overseer remediation commit
`d2eae2e2963c51dc59d8c2aab71fd5e4ac2ea95f` rejects preexisting unbound admin
and Roadex sources inside `BEGIN IMMEDIATE` before invoking the callback. It
preserves idempotent replay, atomic rollback, and concurrent-call behavior.

### Independent rereview

- Critical: none
- Important: none
- Minor: none
- Security: **PASS**
- Quality: **APPROVED**

The rereview resolved the initial Important finding and approved the final
authority boundary. The preferred Spark coding model could not be used because
its quota was unavailable, so an advisory frontier fallback was used for the
remediation. That routing note is process metadata only, not a product or
security risk.

## Security Verdict

**PASS — Quality APPROVED.** Stockwell found no remaining Critical, Important,
or Minor findings after rereview of the remediation. Source approval must not
be interpreted as approval to deploy, restart a service, stage or decide a real
approval, provision a resource, or change a gateway, route, network, firewall,
or IDS policy.
