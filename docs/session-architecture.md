# Roadex Session Architecture

## Objective

Roadex sessions should feel like a remote Codex terminal while keeping all privileged execution server-side and policy-controlled. The browser is an input and display surface; it does not become a trusted execution environment.

## Session Model

Each Roadex session is bound to:

- An authenticated user identity.
- One approved project workspace.
- One server-side Codex process runner allocation.
- A stream channel for prompts, assistant output, terminal-like events, and lifecycle updates.
- An audit trail for security-sensitive events.

## Project And Thread Selection

The browser may choose a project only from the server-approved workspace registry. Within that project, it may select an active or archived Roadex session owned by the authenticated user, or explicitly create a new thread. Selecting an archived thread reopens the same Roadex session and preserves its Codex thread identifier and transcript.

Roadex does not enumerate or attach arbitrary Codex CLI history from the server. Thread selection remains constrained to sessions created through Roadex so workspace authorization, ownership checks, audit records, and lifecycle controls continue to apply.

The first implementation should use a mock session runner and typed API contracts. Real Codex process spawning should be added only after the policy checks, audit hooks, and isolation tests exist.

## Request Flow

1. User authenticates in the browser.
2. Browser requests a session for a specific workspace.
3. Server validates the user, workspace scope, session quota, and security gates.
4. Server creates or resumes the session runner.
5. Browser attaches to a streaming channel for session output.
6. User prompts and commands are submitted through the server policy layer.
7. Server records audit events for lifecycle changes and sensitive requests.

## Streaming Transport

The first transport should support:

- Server-to-client streamed Codex output.
- Client-to-server prompt submission.
- Reconnect and resume for mobile sleep or network drops.
- Explicit lifecycle states: pending, ready, streaming, paused, blocked, closed.

Server-sent events are a practical first option for output streaming, with normal authenticated HTTP requests for prompt submission. WebSockets can be introduced later if bidirectional terminal emulation requires lower-latency interaction.

## Workspace Isolation

Workspace paths must be server-defined and policy-checked. The client may select from authorized workspaces but must not submit arbitrary filesystem paths. Path traversal, symlink escape, and cross-user workspace attachment must be blocked before a Codex runner starts.

## Audit Events

Roadex should record audit events for:

- Session create, attach, detach, pause, resume, and close.
- Workspace selection and authorization decisions.
- Prompt submission metadata.
- Sensitive command approval decisions.
- Failed authorization and policy denials.
- Future device bridge consent and revocation.

Audit entries should avoid storing secrets, raw credentials, private key material, or large command output by default.

## Deferred Codex Runner

The real Codex runner should stay behind a narrow interface:

- `createSession`
- `attachToSession`
- `submitPrompt`
- `pauseSession`
- `closeSession`

The first concrete implementation should keep this interface mocked. Real process execution should be introduced after tests verify authentication, authorization, workspace isolation, audit logging, and denial of disabled device access.
