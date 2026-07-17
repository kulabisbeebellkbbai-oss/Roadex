# Roadex Security Architecture Notes

## Security Goal

Roadex exposes powerful server-side Codex capabilities through a browser. The initial app must treat authentication, authorization, session isolation, command visibility, and auditability as core product features rather than later hardening work.

## Trust Boundaries

- Browser client: untrusted display and input surface.
- Roadex web server: authenticated application boundary and policy enforcement point.
- Codex session runner: isolated server-side process that handles project work.
- Project workspace storage: per-user or per-project filesystem boundary.
- Administrative audit store: append-only record for security-sensitive events.
- Future device bridge: separate high-risk boundary that remains disabled until reviewed.

## First Milestone Controls

- Require authenticated user identity before creating or attaching to a session.
- Bind each Codex session to one authorized user and one approved workspace scope.
- Keep all workspace paths server-owned and policy-checked.
- Record session lifecycle events, command approvals, workspace attachment, and security gate decisions.
- Make sensitive actions explicit in the interface instead of silently forwarding them.
- Defer client peripheral access until after the portal and session isolation model are verified.

## Implemented Mock Controls

- `POST /api/auth/mock-login` issues an explicit mock bearer token.
- Session bootstrap, create, prompt, and stream routes require the mock bearer token.
- Workspace selection uses server-approved workspace ids instead of browser-supplied roots.
- Prompt submission is routed to a mock runner only.
- Device bridge requests are denied and audited.
- SSE output is scoped to the authenticated session owner.

## Verification Checklist

- Authentication blocks anonymous session creation.
- Authorization blocks access to another user's sessions and workspaces.
- Workspace path validation prevents traversal outside the approved project root.
- Session reconnect restores only the caller's authorized sessions.
- Audit logs include security-sensitive lifecycle and approval events.
- Device bridge code paths remain unavailable in the first milestone.

## Deferred Device Access

Client device access is a later Roadex phase. Before enabling USB, serial, or firmware flashing workflows, Roadex needs a separate design review covering user consent, platform capability checks, scoped forwarding, revocation, audit logs, and denial-by-default behavior.
