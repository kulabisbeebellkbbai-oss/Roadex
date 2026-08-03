# Roadex A-Team Plan

Generated through The A-Team service on `http://127.0.0.1:8795/`.

- Team id: `ep2qSVAScvWh`
- Status: `approved`
- Project type: `software`

## Summary

Roadex is a browser-first portal for Codex users. It should provide an OpenAI Codex-like interface that feels like running Codex locally on the server while users connect from desktop, mobile, and tablet browsers.

The actual Codex process, project files, tools, and execution environment run server-side. The browser client sends input, receives streamed Codex responses, displays project and session state, and supports interactive work similar to SSH or a remote terminal.

The first release focuses on authenticated browser access to a server-side mock/session-managed Codex workspace with streaming-ready UI, session isolation, and audit visibility. Client device and peripheral access remains deferred until the core portal, session management, project workflow, and security model are working and reviewed.

## Goals

- Build a secure responsive browser portal for desktop, tablet, and mobile.
- Define and implement server-side Codex session management with streaming output.
- Add authentication, authorization, user/session isolation, audit logging, and security review gates before real Codex process control.
- Use A-Team-driven development roles for planning, implementation, security review, and verification.
- Keep security architecture and review gates independently owned by a dedicated Security Architect role.
- Defer client device/peripheral bridge until core portal and security controls are verified.

## Constraints

- Security oversight is mandatory for design and verification.
- Browser client is untrusted; privileged execution stays server-side.
- No real Codex process spawning until auth, authorization, workspace isolation, audit logging, and disabled device access tests exist.
- Local device access must remain disabled until a later reviewed phase.
- Quality gates include npm audit, lint, tests, production build, responsive browser checks, and security-focused tests for auth, authorization, workspace isolation, audit logging, and denial of disabled device access.

## Team

### Hannibal

Role: Project Manager and Delivery Lead

Responsibilities:

- Convert the approved summary into milestones, risks, and decision points.
- Coordinate handoffs across disciplines and keep assignments reviewable.
- Confirm scope changes with the user before reassigning priorities.

Standards:

- Clear acceptance criteria.
- Visible risk log.
- Reviewable handoffs.

### Face

Role: Product Designer and UI Engineer

Coding model: `gpt-5.3-codex-spark` primary, with `gpt-5.6` reserved for
architecture, security-sensitive, or failed-implementation escalation.

Responsibilities:

- Shape user flows, interaction details, interface states, and frontend implementation tasks.
- Keep the UI consistent with the target user, domain, and existing design conventions.
- Provide screenshots or UI review notes for visual changes.

Standards:

- Accessible UI states.
- Responsive layout.
- No unexplained feature text in-app.

### B.A.

Role: Backend and Infrastructure Engineer

Coding model: `gpt-5.3-codex-spark` primary, with `gpt-5.6` reserved for
architecture, security-sensitive, or failed-implementation escalation.

Responsibilities:

- Own APIs, data models, persistence, integrations, deployment shape, and operational safety.
- Keep side effects explicit and add validation around boundary-crossing behavior.
- Document local run, test, and deployment commands.
- Coordinate with the Security Architect before implementing process execution, workspace access, authentication, or device bridge features.

Standards:

- Typed interfaces.
- Least privilege.
- Observable failures.

### Stockwell

Role: Security Architect and Review Lead

Responsibilities:

- Own Roadex threat modeling, trust boundaries, and security review gates.
- Review authentication, authorization, workspace isolation, audit logging, and process execution controls before implementation proceeds.
- Block client device access or real Codex process spawning until required security tests and approvals exist.

Standards:

- Threat model before sensitive implementation.
- Deny-by-default permission boundaries.
- Security tests for every privileged capability.

### Murdock

Role: QA Engineer and Test Pilot

Responsibilities:

- Build focused tests around behavior, regressions, integration points, and user workflows.
- Run verification and report exact failures with reproduction steps.
- Challenge weak acceptance criteria before approval.

Standards:

- Automated tests where practical.
- Manual smoke evidence.
- Bug reports with exact paths.
- Security regression evidence for privileged boundaries.

## Draft Assignments

### Create Delivery Plan

Owner: Hannibal

Brief: Turn the approved summary into milestones, open questions, risks, and review checkpoints.

Acceptance criteria:

- Milestones are scoped.
- Risks have owners.
- User approval points are explicit.

### Design Primary Workflow

Owner: Face

Status: Done for selected-project readiness checkpoint

Brief: Expose non-sensitive selected-project device-profile readiness on the project selector while keeping all actual device controls bound to the attached session.

Acceptance criteria:

- Workflow is usable on desktop and mobile.
- States are covered.
- Visual review evidence exists.

### Implement Service Contract

Owner: B.A.

Status: In progress

Active brief: Define the MSI v7 trusted execution contract for independent viewport contexts and timeout budgets, immediate post-auth suite claiming, gateway heartbeat continuity, deterministic stream cleanup, and redacted aggregate results.

Acceptance criteria:

- Inputs are validated.
- Failures are typed.
- Run commands are documented.
- Existing non-destructive suite and security boundaries remain unchanged.

### Define Security Review Gates

Owner: Stockwell

Brief: Create the Roadex threat model, privileged-action gates, and verification requirements before auth, session execution, or device access work proceeds.

Acceptance criteria:

- Trust boundaries are documented.
- Privileged actions have explicit approval gates.
- Security tests are named before implementation.

### Verify Release Slice

Owner: Murdock

Status: In progress

Active brief: Isolate the v7 tablet and mobile project-device control failures using the same consolidated non-destructive flow, classify runner carryover versus responsive UI behavior, and restore the canonical three-viewport suite after diagnosis.

Acceptance criteria:

- Configured and unconfigured prerequisites are independently observable by bounded case ID.
- Desktop, tablet, and mobile results are captured through the MSI agent.
- No chooser, firmware transfer, write, approval, or operation action is invoked.
- Application defects are handed to Face or B.A.; runner and contract defects remain with Murdock.

Current checkpoint:

- The authenticated portal suite passes on desktop, tablet, and mobile.
- The v6 polling change and selected-project readiness attribute pass configured and unconfigured control boundaries on isolated desktop, tablet, and mobile runs.
- No chooser, firmware transfer, write, approval, or operation action was invoked.
- The canonical suite uses one end-to-end case per viewport to model a real project/thread switch and avoid exhausting the intentional live-stream subscriber limit with diagnostic page fan-out.
- MSI agent v6 still needs independent viewport contexts and timeout budgets for reliable combined execution; this is an agent limitation, not a Roadex control-state failure.
- MSI agent v7 passes the portal suite across all viewports, but the combined device-control flow passes only desktop. The unchanged tablet-only and mobile-only flows both pass, classifying the remaining defect as browser-process transport carryover rather than Roadex responsive behavior.
- The next trusted-runner change must launch and close a separate Chromium process per viewport, await stream termination and process exit, then rerun the restored canonical three-viewport suite.
- Roadex heartbeat deployment now makes the gateway close upstream streams promptly as `client_closed` with no subscriber-limit denial. Agent v8 still marks passed viewport work interrupted because expected EventSource cancellation remains in its request tracker.
- Agent v9 must preserve passed assertions across expected teardown cancellation and must never claim a suite after authentication returns `needsUser` or `failed`.
- Agent v9 fixed authentication gating, but both canonical suites reported only interrupted cases because same-origin non-stream requests remained active when deliberate browser teardown began.
- Agent v10 must freeze the assertion result before teardown and treat cancellation of approved-origin requests caused solely by successful browser shutdown as expected cleanup, without suppressing any pre-teardown failure.
- Agent v10 authenticated successfully and the gateway showed only successful requests with bounded `client_closed` stream teardown, but the runner still published every canonical case as interrupted. Agent v11 must make terminal case results immutable, track cleanup separately, and use event timestamps so post-teardown callbacks cannot rewrite passed assertions.
- Source inspection confirmed agent v11 still mutates appended passed records in a post-cleanup block. Agent v12 must remove that mutation, report cleanup health separately, add source-level fixtures for post-teardown cancellation and real cleanup failure, and change the installed runner hash before canonical acceptance is rerun.
- Agent v12 passed authentication and both canonical suites across desktop, tablet, and mobile. Gateway correlation showed only successful reads, normal `client_closed` streams, no diversion, and no privileged device route. Roadex now permits the optional redacted cleanup aggregate that v12 could not emit under the previous result schema.
- Agent v13 emitted cleanup aggregates but exposed contradictory classification: passed cases coexisted with cleanup timeouts and claimed pre-teardown request failures while gateway evidence showed prompt successful closure. Agent v14 must timestamp the teardown boundary, stop waiting on request objects after browser exit, and satisfy the schema invariant that passed jobs have no cleanup timeout or pre-teardown failure.
- Corrected agent v14 passed the canonical portal suite with clean cleanup aggregates. One initial tablet device-control assertion was transient; the immediate full canonical retry passed desktop, tablet, and mobile with all cleanups successful, no timeout, and no pre-teardown failure. Gateway correlation remained successful and non-privileged throughout.

## Approval Gate

This team is approved. Development after this point must be assigned and reviewed through this A-Team plan.

## Controlled Runner Capability Profile

Status: Deployed for the approved owner/workspace pair

- B.A. implemented a default-off `controlled-project-manager` runner profile.
- Exact authenticated user and workspace allowlists are checked on every prompt.
- Controlled runs ignore user-global configuration and receive only fixed
  A-Team and Skiller MCP definitions.
- The Codex shell remains `workspace-write` with network access denied and no
  parent workspace added.
- Stockwell completed the privilege-boundary review.
- Murdock verified focused tests, the full suite, lint, production build,
  strict Codex configuration parsing, and live A-Team/Skiller calls.
- The user service was rebuilt and restarted through approved Overseer plan
  `admin.roadex-controlled-runner-20260725`.
- Runtime scope is limited to authenticated user `owner` and workspace
  `codex-project-ai-project-manager-cacb4e3a`.
- A Roadex-managed smoke completed A-Team `list_teams` and Skiller
  `recommend_skills` without approval cancellation.
- No global Codex configuration, sibling project creation, gateway/firewall
  change, device capability, or project-creation broker was enabled.

Next approval boundary: design and implement a one-time Roadex grant broker
before allowing controlled creation of a sibling project.

## Project Creation Grant Broker Design

Status: Roadex-local worker and registrar deployed; gateway/live smoke pending

- Design: `docs/project-creation-grant-broker-design.md`
- The broker is server-side and is never exposed as a Codex/model tool.
- A fresh Roadex owner confirmation independently authorizes one exact project.
- A-Team evidence is verified but cannot authorize creation by itself.
- The operation is single-use, durable, idempotent, expiring, revocable before
  lease, and recoverable after partial external success.
- Parent-workspace writes and GitHub access remain unavailable to the Codex
  runner.
- The existing `codex-projects --new-project` command will not be invoked
  unchanged because it is not transactional and delegates GitHub creation to a
  new Codex thread.
- Roadex now contains default-off proposal, challenge, confirmation, revocation,
  and status source plus a durable SQLite state machine.
- AI Project Manager contains an isolated hardened adapter and local tests.
- Roadex now includes the owner proposal/review, fresh confirmation, status,
  and revocation UI source.
- Protected Service Gateway now includes exact default-off project route,
  schema, owner-principal, Origin, CSRF, rate, IDS, durable idempotency, and
  response-projection handling.
- Intrusion Detection now accepts only the exact normalized project routes and
  the redacted project-creation-disabled reason.
- Roadex owns a durable expiring global worker lease and ordered resumable
  operation checkpoints.
- AI Project Manager owns fixed filesystem preparation, shell-free command
  execution, and strict remote and upstream verification.
- The existing `codex-projects --new-conversation` path was rejected because it
  bypasses the controlled Roadex runner profile. Roadex now refuses to claim
  work before any side effect unless the separately default-off controlled
  bootstrap and hardened registrar are ready.
- After the adapter reaches the durable `pushed` checkpoint, Roadex owns the
  fixed controlled bootstrap and invokes the non-launching shared registrar.
- The registrar verifies fixed-root containment, operation marker, Codex state
  cwd and age, a dedicated HMAC binding, conflicts, durable atomic registry and
  launcher writes, strict projection, and pseudonymized durable audit.
- Runtime enablement, service restart, local project creation, and GitHub
  creation remain separate deployment boundaries.
- Approved project creation now stages automatic controlled-runner enrollment:
  the verified registered workspace/thread evidence is persisted at the
  `thread-started` checkpoint and an exact server-owned grant is inserted in
  the same SQLite transaction as `completed`. Selection revalidates the
  authenticated owner, workspace ID/root, and managed/Codex thread identity on
  every prompt. Static workspace entries remain a compatibility path.
- Automatic enrollment source and local regression tests do not by themselves
  authorize rebuilding or restarting the live Roadex service.
- Long-running Codex directives are supervised until child-process completion
  rather than terminated by a fixed wall-clock deadline. The owning session
  carries bounded active-run timestamps, the UI displays an accessible working
  indicator, and explicit cancellation plus global runner concurrency limits
  remain enforced.
- Conversation history uses a fixed responsive scroll viewport. The browser
  remembers only an opaque selected session ID and restores it only after an
  exact match against the current authenticated user's active bootstrap
  sessions; stale or cross-user values fall back safely.
- Controlled verification and Git publication are being designed as separate
  default-off, prompt-bound host operations. General runner networking remains
  denied; exact grants bind current workspace and repository state, and no live
  broker or operation is authorized by source implementation alone.
- The Projects panel provides accessible per-thread archive actions to release
  active-session capacity. Blocked or paused owned sessions can be recovered
  through the existing protected reopen contract only when no runner is active;
  recovery preserves identity and transcript and does not submit work.
- Roadex-local worker/bootstrap/registrar configuration was deployed on
  2026-07-25 through Overseer plan
  `admin.roadex-project-creation-worker-20260725`.
- The five exact owner-only gateway routes and corresponding IDS schemas were
  deployed on 2026-07-25 through approved Overseer plans
  `admin.roadex-project-gateway-20260725` and
  `admin.roadex-project-ids-20260725`.
- Gateway and IDS full suites passed before restart, service health passed
  after restart, and the Codex registry remained unchanged.
- Authenticated MSI negative-schema smoke passed with a JSON `403`; gateway and
  IDS recorded matching redacted rejection evidence, no project state was
  created, and the Codex registry remained unchanged.
- Sibling directory creation, GitHub creation, live controlled bootstrap, and
  live Codex registry mutation remain a separate explicit approval boundary.

## Controlled Operations Deployment

Status: deployed and locally verified; live DonutHole mutation not authorized

- B.A. implemented the exact grant, broker, workspace inspector, durable replay
  and audit, fixed executor, Unix listener, MCP transport, and dedicated npm
  registry and GitHub SSH adapters.
- Stockwell required and verified exact `roadex.service` cgroup peer pinning,
  global-unicast-only DNS allowlisting, transactional installer rollback,
  strict SSH host keys, fixed commands, key separation, and fail-closed gates.
- Murdock's final gate passed all 39 test files and 308 tests, lint, production
  build, zero-vulnerability dependency audit, diff checks, disposable npm
  adapter smoke, forced installer rollback, and same-UID denial.
- O'Brien/Overseer plans
  `admin.roadex-controlled-operations-final-activation-20260730` and
  `admin.roadex-controlled-operations-final-roadex-20260730` completed.
- `roadex.service` and `roadex-controlled-operations.service` are active; the
  Unix socket is owner-only and an arbitrary same-UID process outside the
  Roadex service cgroup is denied.
- No grant has been consumed, no controlled audit event exists, and no
  DonutHole dependency install, lockfile creation, commit, or push occurred.
- The next boundary is explicit approval for one live DonutHole operation.

## Human-Approval Continuation Workflow

### 2026-08-02 Task 7 verification checkpoint

Status: Roadex source, bounded local verification, independent security review,
and approval-workflow responsive browser verification passed; deployment not
authorized

- Reviewed Roadex implementation HEAD is
  `08a0e3ba4dbd4c733467deff00f3527c8accf7ce`. Task 5 received independent
  PASS/APPROVED at `9d13f05`; Task 6 received PASS/APPROVED at `32a020d`.
  Stockwell initially reviewed Overseer `f345769`; the accepted no-backfill
  remediation is `d2eae2e2963c51dc59d8c2aab71fd5e4ac2ea95f`.
- B.A.'s backend assignment is `done` after the Overseer remediation and
  independent rereview. Face's UI assignment is `done` for source,
  component/server-rendered tests, CSS/mobile fixtures, and responsive browser
  verification. The default 30-second mobile run first timed out during browser
  launch; a harness-only 120,000 ms timeout exposed pointer interception at the
  semantic Close navigation target. Commit `08a0e3b` constrains the drawer to
  `min(360px, calc(100vw - 44px))` and starts the backdrop after it, preserving
  a reachable 44px close target. Independent reruns passed 14
  `humanApprovalUi` tests, lint, and the exact approval mobile E2E on Android
  Pixel 7 and iPhone 15 with `--timeout=120000`.
- Murdock's recorded Roadex gates are green: combined focused 8 files/231
  tests, exact Task 7 approval suite 8 files/137 tests, bounded full Roadex 48
  files/503 tests, lint, server TypeScript compilation, production build,
  zero-vulnerability audit, clean diff check, and the post-fix two-device
  approval mobile E2E. Murdock is `done` for the Task 7 verification scope.
- In the source-only Overseer worktree, the exact Roadex projection suite
  passed 133 tests, the approval-status API subset passed 10 tests, and a
  selected suite excluding one unrelated UI matrix test passed 180 tests with
  1 deselected. The isolated unrelated
  `gateway_prefix_exposes_authenticated_panel_matrix` remains not green because
  `/Overseer/virtual/evidence` exceeds the temporary `LocalApiHarness` hard
  five-second timeout. Live Overseer health returned `ok` during a read-only
  check, and the tests did not use live state. This unrelated gateway UI-matrix
  timeout is explicitly qualified and is not a blocker for Task 7.
- Stockwell's initial verdict was `FAIL / CHANGES_REQUESTED` for one Important
  no-backfill gap. Remediation now rejects preexisting unbound admin and Roadex
  sources inside `BEGIN IMMEDIATE` before the callback while preserving
  idempotent replay, atomic rollback, and concurrency. Independent rereview
  found Critical none, Important none, and Minor none; Stockwell is `done` with
  **Security PASS / Quality APPROVED**.
- The fake-provider/fake-runner lifecycle integration passed without live
  provider, approval, provisioning, or browser dependence. It covers the same
  managed thread, a one-run grant, persist-before-terminal ordering, the
  immediate-resolve race, and shutdown.
- `docs/human-approval-continuation-verification.md` records the qualified
  evidence and a default-off deployment handoff. The restart command is marked
  not executed; no checksum or live result is invented.
- No deployment, restart, live smoke, approval mutation, provisioning, network,
  gateway, firewall, or IDS action occurred. Source approval does not authorize
  deployment or real provisioning. A separate Overseer admin plan is required
  for any deployment/restart and any separate Overseer producer integration.

### Approved design and ownership history

Status: design and limited source expansion approved; implementation plan was
approved for source and local-test execution

- Approved design:
  `docs/superpowers/specs/2026-08-02-human-approval-continuation-design.md`
- B.A. owns the persisted approval-wait state machine, read-only Overseer
  provider, session-bound MCP registration, coordinator, and internal
  continuation dispatch.
- Face owns the safe session projection, transcript waiting card, header
  indicator, prompt gating, reconnect behavior, accessibility, and responsive
  layouts.
- Stockwell owns the authority-boundary, redaction, fail-closed, and security
  review.
- Murdock owns focused, restart, idempotency, responsive, integration, and
  harmless managed-thread smoke verification.
- Roadex may observe an exact authoritative approval but cannot create, alter,
  infer, dispatch, or grant it.
- Privileged operational approvals identify the Admin Console; project and
  workflow approvals identify the Overview Console. The controlled thread
  cannot choose the console target or a URL.
- Only a verified `approved` decision queues automatic continuation in the same
  managed thread. Rejection, revision, expiry, revocation, and ambiguous crash
  recovery never fail open.
- Existing app-publication worktree changes remain separate and must be
  preserved during implementation.
- Source implementation and local tests do not authorize a Roadex service
  rebuild, restart, live approval mutation, provisioning action, gateway
  change, firewall or IDS change, or protected live smoke.
- The approved limited Overseer source expansion adds an immutable Roadex scope
  binding inside a producer's original staging transaction and one
  authenticated exact read-only status projection. Legacy unbound approvals
  stay valid in Overseer but are ineligible for Roadex auto-resume. There is no
  binding-rewrite, approval, execution, list, or live-data migration endpoint.
- This approval covers source changes and local tests only. It does not cover
  an Overseer or Roadex service rebuild/restart, deployment, live approval
  mutation, provisioning, protected smoke, gateway, firewall, or IDS change.
