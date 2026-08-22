# Per-Project Roadex Human Thread Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use Superpowers executing-plans to implement this plan task-by-task. Use test-driven development for every behavior change and verification-before-completion before reporting a task done.

**Goal:** Give every managed project exactly one current Roadex human-interaction thread, including safe creation for missing/imported projects, exact recovery, generation-based replacement, visible read-only predecessors, and project-scoped non-approval question routing.

**Architecture:** Roadex owns an append-only SQLite lifecycle and durable delivery outbox. A dedicated local Overseer relay carries signed binding and message receipts without entering approval tables. Psychlo stores a rebuildable project-thread projection and uses it only for non-approval human interactions. Codex registry and launcher state remain derived locators, never authority.

**Tech stack:** TypeScript, React, Node `node:sqlite`, Vitest, Python 3, SQLite, Zod, Psychlo event projections, Overseer authenticated peer transport, Playwright MCP.

**Approved specification:** `docs/superpowers/specs/2026-08-22-per-project-roadex-human-thread-design.md`

## Delivery rules

- Implement in isolated worktrees from clean, recorded repository heads.
- Preserve unrelated dirty files and local data.
- Use canonical JSON and SHA-256 for every cross-service record.
- Use full conversation IDs. Short launcher or tmux names are display locators only.
- Keep project human interaction structurally separate from Overseer approval tables, routes, tokens, and continuation capabilities.
- Commit each task independently after its focused tests pass.
- Do not deploy, restart services, migrate live databases, create live project threads, or modify the live Codex registry in this plan.

## Task 1: Freeze the shared project-thread contract

**Roadex files:**

- Create: `src/shared/projectHumanThreadContracts.ts`
- Create: `tests/projectHumanThreadContracts.test.ts`

**Psychlo files:**

- Create: `src/contracts/project-human-thread.ts`
- Create: `tests/unit/project-human-thread-contract.test.ts`

**Overseer files:**

- Create: `tests/fixtures/project-human-thread-v1.json`
- Create: `tests/test_project_human_thread_contract.py`

1. Write failing strict-schema tests for binding generation, lifecycle status,
   project identity, message request, response, canonical digests, exact keys,
   stale generation, and malformed IDs.
2. Define versioned schemas:
   - `roadex.project-human-thread-binding.v1`
   - `roadex.project-human-thread-message.v1`
   - `roadex.project-human-thread-response.v1`
3. Add one frozen cross-language fixture containing an active binding, one
   bounded-choice question, and one response.
4. Verify all three implementations compute byte-identical canonical digests.
5. Run focused contract tests and commit.

## Task 2: Add Roadex append-only binding persistence

**Files:**

- Create: `src/server/projectHumanThreadStore.ts`
- Create: `tests/projectHumanThreadStore.test.ts`
- Modify: `.gitignore` only if a new default runtime database path requires it

1. Write failing tests for:
   - generation-one creation and exact replay;
   - unique active binding per project;
   - conversation uniqueness across projects;
   - append-only unavailable, replacement-pending, and retired transitions;
   - compare-and-swap replacement;
   - durable outbox insertion in the same transaction;
   - crash/reopen and full projection rebuild;
   - immutable predecessor records.
2. Add SQLite tables for lifecycle events, current projection, binding receipts,
   message outbox, response inbox, and audit records.
3. Use `BEGIN IMMEDIATE`, `PRAGMA journal_mode=WAL`, `synchronous=FULL`, strict
   unique indexes, and insert-only idempotency keys.
4. Rebuild projections from events and compare the rebuilt state with the live
   projection in tests.
5. Run `npm test -- tests/projectHumanThreadStore.test.ts` and commit.

## Task 3: Build a descriptor-bound Codex thread authority adapter

**Files:**

- Create: `src/server/projectHumanThreadAuthority.ts`
- Create: `tests/projectHumanThreadAuthority.test.ts`
- Modify: `src/server/projectThreadRegistrar.ts`
- Modify: `tests/projectThreadRegistrar.test.ts`
- Modify: `tests/test_controlled_thread_registrar.py` only for compatibility
  coverage against the installed registrar contract

1. Write failing tests proving creation returns a full conversation ID and exact
   canonical working directory, rejects symlink/path substitution, rejects an
   archived or missing state row, and never treats CSV/launcher recency as
   authority.
2. Split controlled thread creation from optional locator registration.
3. Validate the Codex state database and project root through held descriptors
   before activating a Roadex binding.
4. Add read-only candidate inspection for explicit adoption. Return all exact
   candidates; never select one automatically.
5. Add safe same-ID locator repair. It may recreate a missing derived launcher
   only after the authoritative Roadex binding and Codex state row agree.
6. Keep all creation/repair subprocess environments closed and credential-free.
7. Run the TypeScript authority/registrar tests and the Python compatibility
   test; commit.

## Task 4: Implement create, adopt, recover, and replace services

**Files:**

- Create: `src/server/projectHumanThreadService.ts`
- Create: `tests/projectHumanThreadService.test.ts`
- Modify: `src/server/projectCreationWorker.ts`
- Modify: `tests/projectCreationWorker.test.ts`

1. Write failing service tests for:
   - new-project create and exact retry;
   - imported-project create-if-missing;
   - explicit verified adoption;
   - ambiguous candidate refusal;
   - same-thread recovery and locator repair;
   - unavailable transition when the conversation cannot be recovered;
   - authenticated replacement with expected generation;
   - concurrent replacement winner;
   - crash before and after activation;
   - read-only predecessor history.
2. Implement lifecycle operations as store transactions around the authority
   adapter. Never hold a database transaction while spawning Codex.
3. Introduce durable intent/finalize phases for creation and replacement so a
   crash can be reconciled without creating a second conversation.
4. Integrate new project finalization so successful project creation records
   generation one. Convert ambiguous external success to a reconcilable intent,
   not an unbounded retry.
5. Run focused service and worker tests; commit.

## Task 5: Expose owner-bound Roadex APIs

**Files:**

- Modify: `server/index.ts`
- Modify: `src/client/sessionApi.ts`
- Create: `tests/projectHumanThreadRoutes.test.ts`
- Modify: `tests/sessionService.test.ts`

1. Write failing route tests for authenticated list/current/history, create
   missing, candidate inspection, explicit adoption, recovery, and replacement.
2. Add exact routes under `/api/projects/:projectId/human-thread`.
3. Require CSRF protection and project ownership for every mutation.
4. Require `expectedGeneration`, idempotency key, and a bounded reason for
   replacement. Return typed `409` conflicts for stale operations.
5. Ensure retired history is redacted, read-only, and scoped to the owner.
6. Add negative tests for cross-owner access, arbitrary project roots, unknown
   fields, approval-like payloads, and active-run replacement.
7. Run focused route/session tests; commit.

## Task 6: Build the Roadex project-thread UI

**Files:**

- Modify: `src/hooks/useRoadexSession.ts`
- Modify: `src/client/sessionApi.ts`
- Modify the existing selected-project/session components discovered during
  implementation; keep component edits focused
- Create or modify adjacent component tests

1. Add failing component tests for current thread, missing thread, unavailable,
   recovery, replacement confirmation, and read-only predecessor history.
2. Add a project conversation entry point that opens the current thread.
3. Show `Create project conversation` only for eligible missing bindings.
4. Show recover and replace actions only in valid lifecycle states.
5. Keep retired predecessors visible, labelled read-only, and linked to their
   successor.
6. Do not render project-thread content as an Overseer approval control and do
   not link it to approval execution routes.
7. Run component tests, lint, and build; commit.

## Task 7: Add a dedicated Roadex-to-Overseer relay contract

**Roadex files:**

- Create: `src/server/projectHumanThreadRelay.ts`
- Create: `tests/projectHumanThreadRelay.test.ts`
- Modify: `server/index.ts` only for dependency wiring

**Overseer files:**

- Create: `src/overseer/roadex_project_threads.py`
- Modify: `src/overseer/psychlo_bridge.py`
- Create: `tests/test_roadex_project_threads.py`
- Modify: `tests/test_psychlo_bridge.py`

1. Write failing composed tests for a dedicated local authenticated transport
   that accepts only project-thread binding/message records.
2. Give this relay a distinct endpoint, secret/domain separator, nonce ledger,
   tables, and DTOs. Do not reuse Roadex approval endpoints or records.
3. Persist Roadex outbox entries before send; accept only exact signed receipts
   before marking delivered.
4. Persist Overseer relay inbox/outbox entries and exact replay receipts before
   forwarding to Psychlo.
5. Add negative tests proving project-thread messages cannot reference, alter,
   decide, cancel, or execute any Overseer approval plan.
6. Verify lost response, restart, replay, nonce reuse, body substitution, and
   concurrent send behavior; commit each repository's slice.

## Task 8: Add Psychlo project-thread projection and routing

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/internal/sqlite-event-store.ts`
- Modify: `src/peer/protocol.ts`
- Modify: `src/http/overseer-peer-route.ts`
- Create: `src/services/project-human-interactions.ts`
- Create: `tests/integration/project-human-thread.test.ts`
- Modify: `src/index.ts`

1. Write failing tests for binding receipt insertion, exact replay, stale
   generation rejection, project mismatch, rebuild parity, and replacement.
2. Add immutable events and projections for the current binding plus history.
3. Add exact Overseer peer kinds for binding and human-response delivery.
4. Add a durable question outbox. Record a question before relay and accept a
   response only for the exact project, conversation, generation, and message.
5. Keep this service separate from `DecisionService`; ordinary human responses
   cannot consume lifecycle scheduling gates or record decision outcomes.
6. Replace global Roadex workflow routing only for the new non-approval message
   path. Preserve existing decision behavior for compatibility.
7. Reconcile pending binding receipts, questions, and responses during startup
   before scheduling new work for the affected project.
8. Run focused integration, migration, rebuild, and typecheck tests; commit.

## Task 9: Prove end-to-end separation and recovery

**Files:**

- Add one frozen cross-repository integration fixture in each repository
- Add composed tests adjacent to the Roadex relay, Overseer bridge, and Psychlo
  interaction service

1. Compose the real Roadex sender, Overseer relay, and Psychlo receiver with
   independent stores and frozen secrets.
2. Prove create binding, deliver question, record user response, forward exact
   response, and restart every service between each boundary.
3. Prove a response containing `approved`, `deploy`, and an Overseer plan ID is
   still ordinary text and cannot change an Overseer approval or Psychlo
   decision record.
4. Prove replacement retires the old generation, stale responses reject, and
   predecessor history remains byte-identical.
5. Prove imported-project create-if-missing and explicit adoption.
6. Run focused cross-repository suites and commit fixture parity changes.

## Task 10: Migration, operations, and browser acceptance

**Files:**

- Modify: `docs/a-team-plan.md`
- Modify: `docs/operations.md`
- Add migration/runbook documentation adjacent to the approved specification
- Add Roadex UI tests adjacent to existing project/session tests

1. Document a dry-run reconciliation report with categories `valid`, `missing`,
   `candidate`, `ambiguous`, and `invalid`.
2. Ensure dry-run is read-only and never invokes generic mutating
   `codex-projects` list/sync behavior.
3. Document source deployment order: Psychlo receiver, Overseer relay, Roadex
   producer/UI, then project reconciliation.
4. Use Playwright MCP for desktop, tablet, and phone acceptance of current,
   missing, unavailable, replacement, and predecessor states.
5. Run Roadex full tests/lint/build, Psychlo focused/full/typecheck/build/lint,
   Overseer focused/full/compile checks, and cross-repository fixtures.
6. Commit documentation and acceptance fixtures.

## Task 11: Independent final security review

1. Review binding authority, project ownership, root identity, Codex state
   attestation, replacement CAS, outbox replay, cross-service signatures,
   startup reconciliation, and approval separation.
2. Adversarially test duplicate active bindings, stale replies, ambiguous
   adoption, symlink/hardlink/path replacement, registry/launcher substitution,
   cross-project access, malformed events, rebuild ordering, and approval text.
3. Require zero unresolved Critical or Important findings.
4. Re-run all affected focused suites after every correction.
5. Do not deploy during review.

## Task 12: Prepare separately approved deployment and migration

1. Record exact repository commits, manifests, test evidence, service versions,
   current live project/thread inventory, and database backup/rollback paths.
2. Stage separate Overseer plans for migrations, service restarts, and the first
   project-thread reconciliation batch.
3. Deploy in the documented receiver-first order only after approval.
4. Run reconciliation in dry-run mode first. Require explicit user selection for
   ambiguous candidates.
5. Create or adopt missing project conversations in a bounded batch, verify the
   active binding and predecessor history, then perform one non-approval
   question/response smoke.
6. Confirm that no Overseer approval record changed during the smoke.
