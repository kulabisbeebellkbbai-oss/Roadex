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

## Approval Gate

This team is approved. Development after this point must be assigned and reviewed through this A-Team plan.
