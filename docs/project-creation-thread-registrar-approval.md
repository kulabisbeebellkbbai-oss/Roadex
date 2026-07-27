# Hardened Project Thread Registrar Approval

Status: Approved and implemented in source; deployment remains unapproved.

## Problem

The default-off project worker can safely reserve the approved destination,
create and verify the Git repository, create and verify the GitHub repository,
and push `main`. It cannot safely call the existing
`codex-projects --new-conversation` path.

That command launches a normal Codex process and does not accept Roadex's
controlled runner capability profile. Direct use would bypass the approved
ignore-user-config, workspace-only write, network-denied tool, and constrained
MCP policy. The adapter therefore reports `thread_registrar_unavailable`
before any local or remote side effect.

## Proposed Source-Only Change

Add a noninteractive registrar operation to the shared Codex project manager.
It must not launch Codex or accept a caller-supplied command, launcher, root,
owner, or arbitrary metadata.

The registrar accepts only:

- a Roadex operation ID;
- an absolute candidate project root beneath the fixed Codex workspace root;
- a Codex thread ID obtained by Roadex's controlled runner; and
- a digest of the approved project identity.

It then:

1. opens and verifies the fixed workspace root without following symlinks;
2. verifies the project directory and Roadex operation marker;
3. reads the Codex session record for the supplied thread ID;
4. requires the recorded working directory to equal the verified project root;
5. requires the session to have been created by the controlled Roadex
   bootstrap invocation for the same operation;
6. rejects existing cross-project or conflicting thread registrations;
7. atomically and durably adds one canonical registry row and launcher;
8. reads the record back and returns a strict public registration DTO; and
9. returns the existing identical record for an idempotent retry.

## Controlled Bootstrap

Roadex, not the adapter or browser, launches the initial Codex thread using the
existing controlled runner configuration plus:

- a fixed server-owned bootstrap prompt;
- `--ignore-user-config`;
- `--ignore-rules`;
- workspace root fixed to the newly verified project;
- no additional writable directories;
- workspace-write sandbox with tool network disabled;
- the existing constrained A-Team and Skiller MCP definitions; and
- bounded JSONL parsing that extracts only the thread ID.

The bootstrap prompt and process environment contain no GitHub credential,
gateway credential, proposal challenge, lease token, or browser input. Project
summary and A-Team files are not included in the prompt.

## Required Controls

- A separate literal-true registrar flag, default off.
- A dedicated HMAC key for operation-to-thread binding.
- A separate dedicated HMAC key for audit pseudonymization.
- Exact fixed workspace root and no-follow containment checks.
- Durable idempotency keyed by operation ID.
- Parent-directory fsync after registry and launcher replacement.
- Existing-row conflict denial and rollback on pre-commit failure.
- No raw session contents, prompt text, command output, credentials, paths, or
  user identifiers in audit logs.
- Pseudonymized operation, project, and thread audit resources.
- Strict response projection containing only registration status, operation
  ID, project display name, and thread ID.
- No GitHub, gateway, IDS, firewall, deployment, or service changes in this
  source-only phase.

## Required Tests

- default-off and malformed-flag denial;
- traversal, symlink, root mismatch, marker mismatch, and case collision;
- missing, malformed, stale, or wrong-working-directory Codex session;
- cross-project and cross-operation thread conflict;
- identical retry and concurrent duplicate registration;
- registry write, launcher write, fsync, and rollback failure injection;
- strict request and public response schemas;
- raw identity, path, prompt, credential, and session-content redaction;
- controlled bootstrap exact arguments and environment allowlist;
- no ordinary `codex-projects --new-conversation` invocation; and
- end-to-end local tests with a fake Codex session store and temporary registry.

## Approval Boundary

Approval authorizes source implementation and isolated local tests in Roadex,
AI Project Manager, and the shared Codex project manager only.

The implemented split leaves repository preparation and remote verification in
the AI Project Manager adapter. Roadex refuses to claim work unless both its
controlled-bootstrap gate and the shared registrar gate are independently
literal true. After the adapter durably reaches `pushed`, Roadex launches the
fixed controlled bootstrap, derives the operation/thread HMAC binding, and
invokes the non-launching registrar over bounded standard input. The shared
manager verifies fake-or-live Codex state, fixed-root containment, the operation
marker, binding, conflicts, and durable registry/launcher commit.

It does not authorize enabling any flag, rebuilding or restarting Roadex,
modifying the live Codex registry, launching a real Codex bootstrap, creating a
project directory, creating or pushing a GitHub repository, or exposing new
gateway traffic. Those remain separate deployment and live-test approvals.
