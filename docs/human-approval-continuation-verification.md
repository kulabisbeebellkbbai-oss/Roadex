# Human Approval Continuation Verification

Date: 2026-08-02

Reviewer: Murdock (independent verification)

Scope: source and local test evidence in `.worktrees/human-approval-continuation-safe`

## Decision

The post-repair approval-continuation source is independently green in its
focused tests, serialized full suite, production build, and diff check.
Verification is **not marked done** because three required environmental gates
could not complete on this host:

- strict ESLint blocked in a kernel filesystem wait;
- `npm audit --audit-level=high` blocked in a kernel filesystem wait before it
  produced a result; and
- responsive Playwright startup blocked while Vite read the checkout, before
  Chromium or any browser assertion ran.

Stockwell independently re-reviewed the raw-environment-token repair, resolved
the Important finding, and recorded a source-security pass with no unresolved
Critical, Important, or Minor findings. No deployment, service restart, live
approval mutation, provisioning, or protected smoke is authorized by this
evidence.

## Roadex test evidence

### Token-file repair

Command:

```text
npm test -- tests/approvalTokenFile.test.ts tests/serverRuntime.test.ts
```

Result: exit 0; 2 files passed, 25 tests passed, 0 failed.

The reviewed repair:

- removes production support for `ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN`;
- accepts only the absolute path in
  `ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE`;
- opens each request with no-follow and nonblocking semantics;
- requires an effective-UID-owned regular file with exact mode `0600`;
- bounds the file to 32 through 256 bytes and validates bearer-token grammar;
- observes replacement and deletion without a service restart; and
- normalizes all reader failures to `approval_status_token_file_invalid`
  without returning the path or token.

The implementation's regular-file check covers non-regular filesystem objects.
The focused table explicitly exercises a directory and symlink; FIFO and device
behavior are enforced by the same nonblocking open plus `fstat` branch but do
not have separately named fixtures.

### Expanded approval-focused suite

Command:

```text
npm test -- tests/approvalWorkflowContracts.test.ts tests/approvalStatusProvider.test.ts tests/approvalCoordinator.test.ts tests/approvalWorkflowGrantBroker.test.ts tests/approvalWorkflowHost.test.ts tests/approvalWorkflowMcp.test.ts tests/approvalLifecycleIntegration.test.ts tests/humanApprovalUi.test.tsx tests/approvalTokenFile.test.ts tests/serverRuntime.test.ts
```

Result: exit 0; 10 files passed, 153 tests passed, 0 failed.

An earlier pre-repair run of the eight Task 7 approval files passed 128 tests.
The first post-repair full run then exposed exactly the expected token custody
failures. Those failures disappeared after the repair and are superseded by the
post-repair results above.

### Full suite

The required default command was attempted:

```text
npm test
```

It produced one timeout in
`controlledWorkspaceInspector.test.ts` during concurrent filesystem-heavy
execution. The affected file immediately passed alone: 1 file, 8 tests. An
earlier full attempt similarly timed out in `controlledOperationsListener`,
which immediately passed alone: 1 file, 5 tests. These failures migrated with
host I/O contention and did not reproduce in isolation.

The complete suite was then run serially:

```text
npm test -- --maxWorkers=1
```

Result: exit 0; 49 files passed, 494 tests passed, 0 failed.

### Build and diff

Command:

```text
npm run build
```

Result: exit 0. TypeScript project build passed and Vite transformed 1,623
modules and produced the client bundle.

Command:

```text
git diff --check
```

Result: exit 0 with no whitespace errors.

### Lint and dependency audit blockers

Command:

```text
npm run lint -- --max-warnings=0
```

Result: blocked. ESLint emitted no diagnostic before its process entered the
kernel filesystem wait (`ext4_find_entry`/`folio_wait_bit_common`). The bounded
command was terminated without a retry, so lint is not reported as passing.

Command:

```text
npm audit --audit-level=high
```

Result: blocked. `npm audit` produced no vulnerability report before entering
`folio_wait_bit_common`. The task-owned process was terminated. High/critical
dependency status is therefore unknown for this verification run.

## Overseer read-only evidence

The plan's exact command could not run in the canonical checkout at
`/home/god/.local/share/overseer/project` because `python` is not installed.
Using `python3` then showed that
`tests/test_roadex_approval_status.py` is absent from that checkout. Running the
two available named files produced 37 passes and one five-second local harness
HTTP timeout in the unrelated protected-gateway panel matrix.

Stockwell separately recorded the actual feature-worktree evidence in
`docs/human-approval-continuation-security-review.md`: 153 approval-focused
Overseer tests passed, while the larger 180-test selection had the same one
unrelated panel-matrix timeout. Murdock did not access live Overseer state.

## Harmless fixture correlation

The local evidence is split across an in-process fake provider/fake runner
lifecycle fixture and the browser reconnect fixture; neither reaches a live
provider, runner, approval, or provisioning service.

The lifecycle fixture correlates:

- session `session-approval-1` and managed thread `managed-thread-1`;
- approval reference `admin.approval-1`;
- the exact SHA-256 decision version and continuation ID stored on the wait;
- the generated runner ID matching `run-[0-9a-f]{32}`;
- one server-built continuation containing the approval reference and decision
  version;
- audit actor `roadex-approval-coordinator` and action `session.prompt`;
- completion with the same continuation ID, runner ID, and observed managed
  thread; and
- terminal `resumed`/`ready` state exactly once, with the wait projection
  removed and the workflow grant revoked.

The tests also prove that the continuation is a system event, never a user
transcript event; a noncanonical prompt, duplicate dispatch, mismatched thread,
and uncertain completion fail closed; and a persisted unacknowledged dispatch
recovers to reconciliation instead of redispatching.

The named responsive fixture models ready session -> typed
`human-approval-pending` response -> server-projected wait -> page reload ->
server-projected terminal/no-wait state. It asserts no user message is appended,
the card and composer remain blocked across reload, and the composer is enabled
only after the server removes the wait. Browser execution of this fixture is
blocked as described below; its source was independently type-checked with
TypeScript, and its pure UI/session behaviors are included in the 153-test
focused pass.

## Responsive browser blocker

Command attempted with a 45-second hard bound:

```text
npm run test:mobile -- --grep "human approval"
```

Playwright printed its command banner, but the configured Vite web server then
entered `folio_wait_bit_common`. Chromium never started for this fixture and no
desktop, tablet, mobile, accessibility, overflow, persistence, reconnect, or
screenshot claim is made from browser execution. Only the source assertions
and unit evidence are available. The orphaned task-owned Vite/npm processes
were terminated.

The unexecuted fixture contains bounded assertions for:

- accessible saved-preference and effective-layout text;
- the full auto -> desktop -> tablet -> mobile -> auto cycle;
- no horizontal overflow in every forced mode;
- auto reevaluation at 390x844, 820x1180, and 1440x1000;
- persisted auto preference across reload;
- overview card, safe relative navigation, blocked composer, and usable drawer;
  and
- reconnect preservation followed by server-authoritative terminal re-enable.

## Prepared deployment and live-smoke approval checklist

This checklist is **prepared only and unexecuted**. Every placeholder must be
resolved from the reviewed deployment candidate and separately approved. No
value below grants approval to deploy or perform a real provisioning action.

- [ ] Overseer admin plan ID: `<separately approved exact plan ID>`
- [ ] Reviewed source revision: `<record exact revision after worktree review>`
- [ ] Build artifacts: reviewed archives of `dist/` and `dist-server/`;
  `<record exact owner-only archive paths after approved preparation>`
- [ ] Artifact checksums: `<record SHA-256 for each prepared archive>`
- [ ] Rollback backup: timestamped, owner-only, ignored storage under
  `local-secrets/backups/`; `<record exact path and permissions>`
- [ ] Environment-file backup: the service source declares
  `local-secrets/roadex-gateway.env`; `<record exact owner-only backup path>`
- [ ] Token-file configuration: set only
  `ROADEX_OVERSEER_APPROVAL_STATUS_TOKEN_FILE=<absolute owner-owned 0600 regular file>`;
  never configure the legacy direct-token variable and never print the token
- [ ] Token-file validation: record owner, mode, regular-file status, bounded
  size, and rotation procedure without recording contents
- [ ] Feature-flag inventory: `<record existing Roadex flags before change>`;
  this feature adds no approval-continuation enable flag, so unrelated
  project-creation, device-bridge, controlled-operation, gateway, firewall, and
  IDS flags must remain unchanged
- [ ] Fixed workflow socket: `/run/user/1000/roadex-approval-workflow.sock`;
  verify owner-only socket mode and expected peer checks after restart
- [ ] Restart command, executed only through the approved Overseer plan:
  `systemctl --user restart roadex.service`
- [ ] Service evidence: `systemctl --user status roadex.service --no-pager`,
  listener remains `127.0.0.1:8780`, and no unexpected listener appears
- [ ] Health evidence: `http://127.0.0.1:8780/api/health`, protected `/Roadex`
  page/bootstrap, and redacted service logs
- [ ] Harmless fixture binding: `<exact separately staged approval reference,
  project, workspace, resource, authority class, and managed thread>`
- [ ] Smoke correlation: `<decision version, continuation ID, audit event ID,
  runner run ID, observed managed thread, and terminal state>`; do not record
  bearer tokens, raw provider bodies, prompts outside the fixed continuation,
  or private errors
- [ ] Mutation boundary: `<separate explicit approval for any real approval
  decision>`; no provisioning, broad dispatch, gateway, firewall, IDS, route,
  repository, or device action is implied
- [ ] Rollback trigger: failed startup, health, socket permission, provider
  scope, redaction, duplicate-dispatch, or correlation check
- [ ] Rollback action: `<restore the separately reviewed artifact/configuration
  pair from the recorded backup through Overseer and restart only roadex.service>`
- [ ] Rollback security check: the selected rollback must not restore support
  for a raw environment bearer token; if no compliant rollback build exists,
  keep approval continuation fail closed and escalate rather than weakening
  credential custody
- [ ] Post-rollback evidence: loopback health, protected page/bootstrap,
  listener/socket permissions, no continuation dispatch, and redacted logs

Approval of source code or this document does not authorize artifact creation,
backup mutation, token-file provisioning, service restart, live approval,
protected smoke, provisioning, or rollback execution.

## Remaining gates

Task 7 can be marked done only after:

1. strict lint completes with zero warnings/errors;
2. `npm audit --audit-level=high` completes with no high or critical finding;
3. the responsive browser fixture runs at the required viewports and produces
   review evidence; and
4. the unrelated Overseer panel-matrix timeout is either cleared or formally
   dispositioned for this gate.
