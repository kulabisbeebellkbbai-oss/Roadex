# Roadex Delivery Plan

## Current Milestone

Roadex is in the secure mock-session milestone. The app may provide browser login, session attach, prompt submission, audit visibility, and SSE-style output using a mock runner only.

## Approved A-Team Assignments

- Hannibal owns delivery checkpoints, risks, and user approval gates.
- Face owns browser workflow, responsive UI, and visible session states.
- B.A. owns server APIs, session contracts, local run commands, and operational boundaries.
- Stockwell owns threat modeling, trust boundaries, and security review gates.
- Murdock owns automated tests, smoke evidence, and release-readiness reporting.

## Completed In This Slice

- Explicit mock authentication endpoint.
- Authenticated bootstrap, session creation, prompt submission, and SSE stream routes.
- Server-owned workspace registry by workspace id.
- Append-only in-memory audit events for session and denial decisions.
- Mock runner that never invokes Codex, shell, filesystem mutation, or device access.
- Frontend API adapter and hook for loading, connected, streaming, and error states.
- Responsive session UI with transcript, prompt composer, security gates, workspaces, and audit events.

## Remaining Before Real Codex Runner

- Persist sessions and audit events outside process memory.
- Add real authentication provider integration.
- Add per-user workspace registry and filesystem isolation checks.
- Add pause, resume, close, and reconnect lifecycle APIs.
- Add integration tests around the HTTP server and SSE authorization.
- Complete Stockwell review before any Codex CLI or process spawning is reachable.

## Disabled Until Later Review

- Real Codex process spawning.
- Shell execution through Roadex APIs.
- Browser-supplied workspace roots.
- Client device access, USB, serial, firmware flashing, WebUSB, WebSerial, or Android forwarding.
