# One-Time Project Creation Grant Broker

Status: Broker, owner UI, gateway contract, IDS schema, durable worker lease,
and adapter execution source plus isolated local tests are complete. Hardened
thread registration is awaiting architecture approval. Exposure, runtime
enablement, and live side effects are not approved.

## Outcome

Roadex may create one sibling Codex project only after an authenticated owner
reviews and confirms an exact project proposal. The Codex runner may use A-Team
and Skiller to prepare the proposal, but it never receives parent-workspace
write access, a project-creation MCP tool, a bearer credential, or GitHub
credentials.

The broker is a Roadex server-side workflow, not a model-callable tool. This
keeps the destructive capability outside the Codex process and its shell
sandbox.

## Current Constraint

`codex-projects --new-project` is not an atomic creation primitive. It currently:

- creates the destination directory and local agent metadata;
- adds a trusted-project entry to the user Codex configuration;
- starts a detached bootstrap conversation; and
- leaves GitHub creation to that new conversation.

It does not bind an approved summary or A-Team snapshot, create and verify the
GitHub repository itself, or provide safe rollback after partial completion.
The broker must therefore use a hardened noninteractive project-manager adapter
rather than invoking the current command unchanged.

## Trust Boundaries

- Browser: untrusted input and rendering surface.
- Protected gateway: authenticates the owner, enforces exact route, Origin,
  CSRF, request size, rate, IDS forwarding, and response projection.
- Roadex: owns proposal validation, confirmation, durable state, audit, and
  orchestration.
- A-Team: supplies planning evidence; it is not sufficient authorization by
  itself.
- Project adapter: narrowly creates one local project, one Git repository, one
  GitHub repository, and one initial managed conversation.
- Codex runner: remains confined to its existing workspace and can neither call
  nor impersonate the project adapter.
- GitHub CLI/API: external side effect with credentials retained outside
  responses, transcripts, arguments logged by Roadex, and persisted records.

## Gates

All gates are independently default-off:

- `ROADEX_PROJECT_CREATION_REQUEST_ENABLED`
- `ROADEX_PROJECT_CREATION_CONFIRM_ENABLED`
- `ROADEX_PROJECT_CREATION_EXECUTION_ENABLED`
- gateway request, confirmation, status, and revoke route flags
- IDS schemas for each exact gateway route

Enabling request intake must not enable confirmation or execution. Enabling
confirmation must not execute previously confirmed records until execution is
separately enabled.

Authorization requires:

- protected-gateway authentication;
- both `admin` and `security-reviewer` roles;
- exact membership in `ROADEX_PROJECT_CREATION_AUTHORIZED_USERS`;
- an owned, active Roadex session in the controlled AI Project Manager
  workspace;
- the same managed Codex thread bound at request and confirmation time; and
- a fresh browser confirmation gesture.

The existing broad `security-reviewer` assignment is not sufficient by itself.
The dedicated authorized-user allowlist is mandatory.

## Records

### Proposal

A proposal stores:

- server-generated proposal ID;
- authenticated user ID;
- Roadex session ID, managed thread ID, and source workspace ID;
- exact ASCII project display name and derived destination basename;
- fixed GitHub owner from server configuration;
- explicit `public` or `private` visibility;
- structured summary fields: outcome, primary users, major components, risks,
  and immediate next steps;
- A-Team ID plus a canonical digest of the fetched team snapshot;
- request idempotency key;
- `pending`, `confirmed`, `revoked`, `expired`, or `consumed` lifecycle;
- creation and expiry timestamps.

Unknown fields are rejected. Caller-supplied paths, GitHub owners, commands,
URLs, team snapshots, approval booleans, and digests are rejected.

### Confirmation

Confirmation stores only a digest of a random, short-lived challenge. The
challenge is returned once to the owner UI after the proposal is revalidated.
A fresh owner gesture submits it to the exact confirmation route. Confirmation
atomically rechecks current auth, roles, allowlist, session/thread ownership,
A-Team snapshot, destination availability, visibility, proposal expiry, and
challenge digest before changing the proposal to `confirmed`.

The controlled runner cannot read or submit the challenge.

### Operation

Confirmation atomically creates one operation linked by a unique proposal ID.
The operation stores normalized project identity, phase, timestamps, bounded
failure classification, and external resource identifiers required for
reconciliation. It stores no GitHub credential, browser credential, raw
gateway identity header, transcript, or arbitrary command output.

Phases are:

- `reserved`
- `local-prepared`
- `remote-created`
- `pushed`
- `thread-started`
- `completed`
- `failed-retryable`
- `reconcile-required`

The proposal is consumed when the unique operation is created, not after all
external work succeeds. Retries resume the same operation and never create a
second operation.

## A-Team Evidence

Roadex fetches the A-Team record from the fixed loopback service and validates:

- exact team ID and project title;
- approved team status;
- no draft assignments required for initial delivery;
- summary and constraints consistent with the proposal; and
- canonical snapshot digest unchanged at confirmation.

A-Team status cannot authorize creation alone because the controlled runner can
invoke A-Team tools. The independent Roadex owner confirmation is the
authorizing event. The source implementation removes `approve_team` from the
controlled runner's preapproved tool list; owner approval flows through the
Roadex confirmation workflow.

A-Team unavailability, malformed responses, changed snapshots, or timeouts fail
closed without consuming the proposal.

## Name And Path Validation

- Accept only ASCII letters, digits, single spaces, `.`, `_`, and `-`.
- Require an alphanumeric first and last character.
- Reject empty, dot, dot-dot, control, slash, backslash, repeated separator,
  reserved, hidden, or case-fold-colliding names.
- Apply a bounded length and derive one canonical basename.
- The workspace root is fixed server-side as
  `/home/god/Documents/Codex Workspace`.
- Open and verify the real workspace root before every phase.
- Use directory-relative, no-follow operations and reject symlinks at every
  existing component.
- Atomically reserve an absent destination with a grant marker before writing.
- Never accept a path from the browser, runner, A-Team, or GitHub response.

Cleanup may remove a failed local reservation only when its inode/device and
grant marker still match the operation and no unrecognized files exist.

## Execution Order

1. Lease the confirmed operation with an expiry and durable unique constraint.
2. Revalidate owner, session/thread, proposal, A-Team snapshot, root, name,
   destination absence, configured GitHub owner, and remote repository absence.
3. Atomically reserve the destination and write explicit starter files,
   including approved summary and A-Team plan snapshots.
4. Initialize `main`, stage only explicit starter paths, verify no secret-like
   or local-only files, and create the initial imperative commit.
5. Create the exact GitHub repository with bound visibility, set `origin`, push
   `main`, and verify owner, name, visibility, default branch, and tracking.
6. Start and register the initial Codex conversation through a new hardened
   project-manager adapter that accepts only the already-created destination.
7. Mark the operation completed and publish a strictly projected result.

The adapter uses argument arrays without a shell and fixed executable paths.
Stdout and stderr are bounded and sanitized before classification; raw output
is never persisted or returned.

## Failure And Rollback

- Before remote creation: a verified empty local reservation may be removed and
  the same operation retried.
- After remote creation: never automatically delete the GitHub repository.
  Persist its owner/name and enter `reconcile-required` until an owner chooses a
  separately approved recovery action.
- After push but before thread registration: retain the valid repository and
  retry only thread registration.
- Process crash or service restart: recover from the durable operation phase and
  probe local/remote state before any retry.
- Revocation is allowed only while a proposal is pending or confirmed and has
  no leased operation. Revocation during execution records a cancellation
  request but cannot pretend an external side effect was undone.

## Persistence And Concurrency

Use a dedicated SQLite store with foreign keys, unique constraints on proposal
ID, idempotency key, canonical destination, and GitHub owner/name. Confirmation,
proposal consumption, and operation creation occur in one immediate
transaction. Use full durability and fsync-compatible settings.

Only one worker may hold an unexpired operation lease. Capacity is bounded and
expiry-aware. Retention must preserve all nonterminal and
`reconcile-required` records regardless of ordinary history caps.

## API And Public Projection

Proposed Roadex routes:

- `POST /api/project-creation/proposals`
- `POST /api/project-creation/proposals/:proposalId/challenge`
- `POST /api/project-creation/proposals/:proposalId/confirm`
- `POST /api/project-creation/proposals/:proposalId/revoke`
- `GET /api/project-creation/proposals/:proposalId`

The gateway exposes only matching `/Roadex/api/...` routes after separate flags
are enabled. Route matching is exact; encoded slash, duplicate slash, suffix,
mixed method, unknown query, and legacy variants are denied.

POST routes require HTTPS, approved Origin, CSRF, JSON content type, bounded
body, strict schema, IDS acceptance, rate limits, and durable idempotency.
Status GET permits no query and returns `Cache-Control: no-store`. Every
response is canonically reserialized from an exact public DTO.

Public records omit user ID, managed thread ID, filesystem root, raw A-Team
snapshot, snapshot digest, challenge digest, idempotency key, command output,
credentials, and internal failure text.

## Audit And Privacy

Audit request, confirm, deny, revoke, lease, phase transition, completion, and
reconciliation events. Use a dedicated HMAC key to pseudonymize actor, session,
proposal, operation, project, and remote identifiers. Never log project
summary text, transcript content, CSRF values, challenges, credentials, paths,
request bodies, headers, or subprocess output.

Audit persistence is part of each state transition. If durable state or audit
cannot be committed, no privileged transition occurs.

## Required Tests

- literal-true default-off gates at Roadex and gateway;
- exact owner roles and dedicated allowlist;
- cross-user/session/thread/workspace IDOR denial;
- closed, archived, revoked, or changed managed-thread denial;
- caller-supplied path/owner/digest/team snapshot rejection;
- malformed, Unicode-confusable, traversal, symlink, case-collision, and
  preexisting destination denial;
- A-Team unavailable, unapproved, changed, oversized, malformed, and stale
  snapshot denial;
- challenge expiry, replay, cross-user use, and stale-browser confirmation;
- atomic proposal consumption and unique operation creation under concurrency;
- idempotent request, confirm, revoke, and retry behavior;
- crash recovery at every operation phase;
- local cleanup marker/inode mismatch refusal;
- GitHub partial-success reconciliation without automatic remote deletion;
- exact visibility, origin, tracking, and default-branch verification;
- strict public DTO, no-store headers, redacted logs, and bounded output;
- exact gateway route/schema/query/Origin/CSRF/rate/IDS behavior;
- controlled runner cannot access the routes, challenge, broker, parent root,
  GitHub credential, or project adapter;
- existing restricted and controlled runner tests remain green.

## Approval Boundary

The approved source-only slice now includes Roadex, the project-manager adapter,
the protected gateway contract, and the IDS receiver schema. It does not
authorize gateway exposure, IDS/firewall activation, runtime flags, service
restart, GitHub repository creation, sibling directory creation, or a live
end-to-end test.

The worker uses a durable global lease, ordered checkpoints, strict fixed-path
adapter events, and reconciliation-required outcomes after ambiguous external
success. It refuses to claim work before all side effects unless both the
controlled bootstrap and hardened registrar are independently ready. Roadex
owns thread bootstrap and registration after the adapter reaches `pushed`. See
`docs/project-creation-thread-registrar-approval.md`.

Those deployment and live-side-effect steps require a later review and explicit
approval after the source and local tests pass.
