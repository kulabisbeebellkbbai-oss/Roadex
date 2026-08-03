# Human-Approval Continuation Verification and Handoff

Date: 2026-08-02

Status: source verification, independent security review, and approval-workflow
responsive browser verification passed; deployment not authorized and not
executed

## Reviewed Source

- Reviewed Roadex implementation HEAD: `08a0e3ba4dbd4c733467deff00f3527c8accf7ce`
- Initial Overseer review target: `f345769`
- Overseer no-backfill remediation:
  `d2eae2e2963c51dc59d8c2aab71fd5e4ac2ea95f`
- Task 5 independent result: PASS/APPROVED at `9d13f05`
- Task 6 independent result: PASS/APPROVED at `32a020d`
- Approved design:
  `docs/superpowers/specs/2026-08-02-human-approval-continuation-design.md`
- Approved plan:
  `docs/superpowers/plans/2026-08-02-human-approval-continuation.md`

## Roadex Verification Evidence

| Gate | Result | Scope and qualification |
| --- | --- | --- |
| Combined focused suites | PASS | 8 files, 231 tests |
| Exact Task 7 approval suite | PASS | 8 files, 137 tests |
| Bounded full Roadex suite | PASS | 48 files, 503 tests |
| Lint | PASS | Completed with no reported failure |
| Server TypeScript compilation | PASS | Server compilation completed successfully |
| Production build | PASS | `dist/` was produced by the build |
| Dependency audit | PASS | `npm audit` reported 0 vulnerabilities |
| Diff check | PASS | Clean |

The local harmless integration is covered by
`approvalLifecycleIntegration`. It uses a fake in-process provider and fake
runner and verifies user-run registration, a paused wait without a browser
subscriber, provider approval, continuation of the exact same managed thread,
one-run grant consumption, coordinator persistence before terminal state, the
immediate-resolve race, and orderly shutdown. It does not use a live provider,
stage or decide a live approval, or perform provisioning.

## Overseer Source-Only Compatibility Evidence

Verification checkout: an isolated Overseer worktree based on the reviewed
approval-status compatibility branch.

- The exact Roadex approval-status projection suite passed: 133 tests.
- The approval-status API subset passed: 10 tests.
- A selected suite with one unrelated UI matrix test deselected passed: 180
  tests, 1 deselected.
- The isolated unrelated `gateway_prefix_exposes_authenticated_panel_matrix`
  test remains **not green**. Its `/Overseer/virtual/evidence` request in the
  temporary `LocalApiHarness` exceeds the harness's hard five-second timeout.
  This result must not be reported as a complete Overseer-suite pass.
- A live Overseer health check was read-only and returned `ok`.
- The projection and API tests did not read the live Overseer state file.

Stockwell's initial review of Roadex `2d8cde1` and Overseer `f345769` returned
**FAIL / CHANGES_REQUESTED** for one Important no-backfill gap. Remediation
`d2eae2e2963c51dc59d8c2aab71fd5e4ac2ea95f` rejects preexisting unbound admin
and Roadex sources inside `BEGIN IMMEDIATE` before the callback while
preserving idempotent replay, atomic rollback, and concurrency behavior. The
independent rereview found no Critical, Important, or Minor findings and
returned **Security PASS / Quality APPROVED**.

No Overseer deployment, restart, state mutation, approval mutation, or
producer integration was performed.

## Responsive and Browser Verification

The default 30-second targeted mobile run first exhausted its timeout during
browser launch. A harness-only rerun with `--timeout=120000` reached product
interaction and exposed a real pointer-interception defect at the semantic
Close navigation target.

Roadex commit `08a0e3ba4dbd4c733467deff00f3527c8accf7ce`
(`Fix mobile drawer close target`) defines `--mobile-drawer-width` as
`min(360px, calc(100vw - 44px))`, uses it for the drawer, and starts the
backdrop after the drawer. This preserves at least a 44px reachable close
target.

Independent post-fix verification passed:

- `humanApprovalUi`: 14 tests;
- lint;
- exact approval mobile E2E on Android Pixel 7 with `--timeout=120000`;
- exact approval mobile E2E on iPhone 15 with `--timeout=120000`.

Component and server-rendered UI tests and CSS/mobile fixture assertions remain
green. Responsive browser verification for the human-approval continuation
workflow is **PASS**. The extended timeout is a harness allowance for browser
startup; unlike the initial launch timeout, the successful runs reached and
passed the product assertions.

## Default-Off Deployment Handoff

This section is a plan for a later, separately approved operation. Every command
below is **NOT EXECUTED**.

### Artifact and checksum

- Reviewed production web artifact at Roadex implementation commit
  `08a0e3ba4dbd4c733467deff00f3527c8accf7ce`: `dist/`.
- Rebuild command: `npm run build` — **NOT EXECUTED for deployment**.
- Checksum-manifest command placeholder to run only after the approved rebuild:

  ```bash
  find dist -type f -print0 | sort -z | xargs -0 sha256sum > <OWNER_ONLY_HANDOFF_PATH>/roadex-human-approval-continuation-dist.sha256
  ```

No artifact hash is asserted in this document.

### Backup and configuration capture

Before rebuilding, an approved admin plan must create an owner-only,
timestamped backup under
`local-secrets/backups/human-approval-continuation-<UTC>/` containing the
currently deployed `dist/`, `dist-server/`, the active `roadex.service` unit
and drop-ins, and the applicable Roadex environment file. The plan must record
permissions and the pre-change service/build identity. No backup was created
for this documentation task.

The admin plan must review and explicitly set or preserve these configuration
inputs:

- `ROADEX_CONTROLLED_RUNNER_ENABLED` (must remain default-off unless a separate
  deployment plan explicitly authorizes the exact controlled-runner scope)
- `ROADEX_CONTROLLED_RUNNER_AUTHORIZED_USERS` (exact authorized-user allowlist;
  no change or authorization is granted here)
- `ROADEX_CONTROLLED_RUNNER_WORKSPACE_IDS` (exact authorized-workspace
  allowlist; no change or authorization is granted here)
- `ROADEX_OVERSEER_APPROVAL_TOKEN_FILE=<absolute owner-only token path selected by the admin plan>`
- `ROADEX_APPROVAL_POLL_MS` (optional polling interval)
- `ROADEX_MAX_APPROVAL_WAITS` (optional persistence bound; source default 500)
- `ROADEX_APPROVAL_WAIT_RETENTION_MS` (optional terminal retention; source
  default 2,592,000,000 ms)

There is no documented deployment authorization, controlled-runner enablement,
allowlist expansion, or other live feature-enable change in this source
handoff. All controlled-runner settings remain default-off and unchanged unless
a separate admin plan approves their exact values and scope. The provider token
path must be absolute, owner-owned, non-symlinked, mode `0600`, non-empty, and
no larger than 256 bytes. The token value must never appear in this document,
logs, checksums, or approval evidence.

Per-run registration tokens are ephemeral and are created only while a managed
run is active under
`/run/user/1000/roadex-approval-workflow-tokens/<UUID>`. The fixed owner-only
socket is `/run/user/1000/roadex-approval-workflow.sock`. Neither location is a
place to pre-stage a reusable token.

### Separately gated restart and health checks

The exact restart command to place in a separate Overseer admin plan is:

```bash
systemctl --user restart roadex.service
```

It is **NOT EXECUTED** and is not authorized by source approval. The later plan
must also record `systemctl --user status roadex.service --no-pager`, verify the
existing loopback listener and `GET http://127.0.0.1:8780/api/health`, verify
the protected `/Roadex` bootstrap through its already approved route, inspect
redacted startup logs, and confirm the socket is a mode-`0600` Unix socket
owned by the Roadex service user.

Any harmless live smoke needs a separately staged, exact, non-provisioning
approval fixture and explicit authorization. Correlate only bounded identifiers:
approval reference, decision version, continuation ID, audit event, runner run
ID, managed thread ID, and terminal wait state. Verify one continuation and no
mutation beyond the fixture. Do not use a real provisioning plan.

### Rollback

If startup, health, socket ownership, redaction, exact provider lookup, or
single-continuation checks fail, the approved operator must stop the smoke,
restore the captured `dist/`, `dist-server/`, service unit/drop-ins, and
environment configuration, then restart only `roadex.service` through the same
Overseer-controlled boundary. Re-run loopback health, protected bootstrap,
listener, socket, and redacted-log checks and record the correlation in the
admin-plan result.

## Uncrossed Boundaries

No deployment, rebuild for deployment, restart, live smoke, live provider use,
approval staging or decision, provisioning, network or route change, protected
gateway change, firewall change, or IDS change occurred. A separate Overseer
admin plan is required for deployment and restart. Any separate Overseer
producer integration or service deployment requires its own reviewed admin
plan.

Approval of the source code does **not** authorize deployment or any real
provisioning action.
