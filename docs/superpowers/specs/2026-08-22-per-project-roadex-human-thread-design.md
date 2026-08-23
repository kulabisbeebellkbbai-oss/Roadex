# Per-Project Roadex Human Thread Design

Status: approved design, pending implementation-plan approval

Date: 2026-08-22

## Purpose

Every managed project has exactly one current Roadex thread dedicated to
ordinary human interaction for that project. The thread is where the project
can ask questions such as whether the user wants to deploy and test an app.

This channel is not an approval authority. Overseer remains the only authority
for Overseer approvals, and Roadex must not infer an Overseer approval from any
message in a project human thread.

## Scope

This design covers:

- creation of a human thread for a new project;
- creation or explicit adoption for an imported or repaired project that is
  missing a binding;
- recovery of an existing thread without changing its identity;
- replacement of an unavailable or intentionally retired thread;
- immutable, visible predecessor history;
- exact routing of non-approval questions and replies; and
- restart, retry, rebuild, and concurrent-operation behavior.

It does not change Overseer approval semantics, grant Roadex approval
authority, deploy services, or migrate live project threads by itself.

## Design principles

1. Roadex owns the authoritative project-to-human-thread binding.
2. A project has at most one active `human-interaction` binding.
3. A full Codex conversation ID is identity. CSV rows, launchers, tmux names,
   and process observations are locators or evidence only.
4. Recovery preserves identity; replacement creates a new generation.
5. Retired generations remain visible and read-only.
6. Missing or ambiguous evidence fails closed. Roadex never selects the newest
   candidate by timestamp or path proximity.
7. Project conversation text cannot create, approve, reject, cancel, or execute
   an Overseer plan.
8. Current and predecessor project human-thread conversations are permanently
   reserved from the ordinary Roadex session list, attach API, reuse fallback,
   and session quota. Roadex never starts a second Codex writer for them.

## Authoritative model

Roadex persists an append-only binding record with these fields:

- `projectId`
- canonical repository root plus stable root identity
- `purpose`, fixed to `human-interaction`
- full `conversationId`
- `generation`, beginning at one and increasing monotonically
- `status`: `active`, `unavailable`, `replacement-pending`, or `retired`
- optional `predecessorGeneration`
- creation mode: `created` or `adopted`
- creation or adoption provenance digest
- optional retirement reason
- `createdAt`, `updatedAt`, and optional `retiredAt`
- canonical record digest

The store enforces:

- one active binding for `(projectId, purpose)`;
- one active project binding for a conversation ID;
- unique `(projectId, purpose, generation)`; and
- immutable identity and provenance fields after insertion.

Projection rows may accelerate reads, but append-only lifecycle events remain
the rebuild authority.

## Service responsibilities

### Roadex

Roadex owns the binding, thread transcript, user-facing project conversation,
recovery and replacement actions, and predecessor-history UI. It verifies
Codex state before activating a binding and emits signed, immutable receipts
for other services.

### Psychlo

Psychlo stores a verified projection of the current Roadex binding for each
project. It routes non-approval questions through the exact active generation
and rejects stale responses. The binding is project-lifetime state and is not
reused as a project-lead, external-round, scheduling, or legacy-successor
thread identity.

### Overseer

Overseer continues to own privileged approval records and actions. Project
human-thread messages are never accepted as approval evidence. If a human
answer leads to a privileged action, the project may prepare a separate
Overseer plan through the existing authoritative workflow.

### Codex project manager

The Codex project manager creates or resumes an exact conversation and repairs
derived registry and launcher locators. Its CSV, launcher, tmux, and discovery
views do not establish the authoritative project binding.

## Lifecycle

### New project

After the project identity and repository root are finalized, Roadex creates a
controlled Codex conversation, verifies its exact Codex state and canonical
working directory, registers its locators, and atomically records generation
one as active. Identical retries return the same binding.

### Imported or repaired project

Project reconciliation checks for an active binding.

- If one exists, it is revalidated and returned.
- If none exists and no valid candidate exists, Roadex creates generation one.
- If exactly one candidate is explicitly selected for adoption, Roadex verifies
  its conversation state and canonical root before binding it.
- If candidates are ambiguous, Roadex requires an authenticated user choice or
  creation of a new conversation. It does not infer a winner.

This operation is idempotent and available independently of initial project
creation so repaired and imported projects cannot remain permanently missing a
human thread.

### Recovery

Recovery always targets the current conversation ID and generation. Roadex
verifies the Codex state row, canonical working directory, thread availability,
and locator integrity. Missing registry or launcher locators may be recreated
from the authoritative binding. Successful recovery does not increment the
generation or modify transcript history.

If the conversation itself is missing, archived beyond recovery, mismatched,
or ambiguous, Roadex marks the binding unavailable and offers replacement.

### Replacement

Replacement requires an authenticated Roadex user action, the expected current
generation, a reason, and no conflicting active delivery or replacement.
Roadex creates and verifies a new controlled conversation before atomically:

1. retiring the current generation;
2. recording the new generation as active; and
3. linking both records through predecessor metadata.

The old thread remains visible and read-only. Concurrent or stale replacements
fail with a generation conflict. A crash before activation leaves the old
generation current; a crash after activation replays to the same new binding.

## Message contract

Every project human-interaction request binds:

- `projectId`
- `conversationId`
- `generation`
- `messageId`
- message kind and canonical content digest
- correlation and idempotency identifiers
- creation timestamp

Responses echo the same identity and bind their own canonical digest. Exact
replays return the same receipt. Conflicting payloads, stale generations, or
responses from retired threads are rejected.

The initial supported message kinds are ordinary question, bounded choice,
clarification, informational notice, and user response. No message kind means
or implies `overseer-approval`.

## User interface

Each project view exposes its current human thread and a history of retired
predecessors. Retired threads have an explicit read-only label and a link to
their successor. The project view exposes recover and replace actions only when
the caller owns the project and the lifecycle permits them.

Questions from the project and the user's responses remain in the dedicated
project-conversation panel. The panel does not expose the reserved conversation
through the generic managed-session launcher: that launcher uses a separate
Codex writer and is not a valid transport for a live dedicated thread.

Imported or repaired projects with no active binding show a bounded
`Create project conversation` action. Ambiguous adoption candidates are shown
without silently attaching any of them.

## Security boundaries

- Dedicated project human threads do not receive approval capabilities,
  approval continuation tokens, project-lead dispatch authority, or controlled
  operation grants.
- A message containing words such as `approved`, `deploy`, or `continue` is
  ordinary conversation data.
- Canonical project-root identity is verified without trusting lexical path
  equality or recency.
- Full conversation IDs are used; shortened launcher names cannot establish
  identity.
- Thread adoption, recovery, and replacement are audited and owner-bound.
- Cross-project adoption, stale-generation writes, duplicate active bindings,
  and replay substitutions fail closed.

## Migration and compatibility

The migration is additive. Existing Roadex sessions and project-lead threads
are not automatically adopted. A reconciliation scan reports projects as:

- already bound and valid;
- missing and eligible for creation;
- candidate available for explicit adoption;
- ambiguous; or
- invalid and requiring repair.

No live thread is replaced during migration. Existing global Psychlo Roadex
workflow configuration remains only for compatibility while project-scoped
bindings are populated; removal requires a later, separately reviewed change.

## Verification requirements

Automated tests must prove:

- new-project create and exact replay;
- imported-project create-if-missing;
- explicit adoption with canonical root verification;
- rejection of multiple or mismatched candidates;
- one active binding under concurrent creation;
- recovery without identity or transcript change;
- locator repair without authority transfer;
- replacement generation compare-and-swap and crash replay;
- immutable, visible, read-only predecessor history;
- stale-generation and cross-project message rejection;
- restart and full-rebuild parity;
- inability of human-thread text to satisfy an Overseer approval; and
- no regression to existing Roadex session, Psychlo decision, or Overseer
  approval workflows.

Browser acceptance must use the configured Playwright MCP at desktop, tablet,
and phone widths for current-thread, missing-thread, recovery, replacement, and
read-only predecessor states.

## Delivery boundaries

Implementation is source-only until focused, full, cross-service, and final
security reviews pass. Database migrations, live thread creation, service
deployment or restart, and migration of existing projects require separate
Overseer coordination and explicit operational approval.
