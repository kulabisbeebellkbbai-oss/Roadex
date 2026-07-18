# Roadex Delivery Plan

## Current Milestone

Roadex has completed the browser portal and real server-side Codex session milestone. The current planning milestone is a disabled-by-default client device bridge with explicit consent, session-scoped grants, device identity verification, and independent security review.

## Approved A-Team Assignments

- Hannibal owns delivery checkpoints, risks, and user approval gates.
- Face owns browser workflow, responsive UI, and visible session states.
- B.A. owns server APIs, session contracts, local run commands, and operational boundaries.
- Stockwell owns threat modeling, trust boundaries, and security review gates.
- Murdock owns automated tests, smoke evidence, and release-readiness reporting.

## Completed Core Portal

- Explicit mock authentication endpoint.
- Authenticated bootstrap, session creation, prompt submission, and SSE stream routes.
- Server-owned workspace registry by workspace id.
- Append-only in-memory audit events for session and denial decisions.
- Real Codex CLI runner for server-approved workspaces.
- Frontend API adapter and hook for loading, connected, streaming, and error states.
- Responsive session UI with transcript, prompt composer, security gates, workspaces, and audit events.

## Completed Session Controls

- Persisted sessions, transcripts, audit events, and managed-thread claims.
- Protected-gateway identity with mock authentication disabled in production.
- Server-owned workspace policy and managed `codex-projects` registry integration.
- Prompt cancellation, archive, reopen, reconnect, live SSE, and active-run thread switching.
- Responsive project and thread navigation for desktop, tablet, and mobile.
- Security and regression review for session ownership, streaming, retention, Origin checks, and rate limits.

## Device Bridge Approval Gates

- Approve the architecture in `docs/device-bridge-design.md` before implementation.
- Complete a revised Security Architect review after artifact delivery, atomic start, identity assurance, operation leases, Android compatibility, and audit privacy are specified.
- Implement capability detection, typed contracts, server-side grants, and denial tests with the feature disabled.
- Review gateway and IDS routes before any external endpoint is exposed.
- Approve browser USB access and a controlled hardware test separately.
