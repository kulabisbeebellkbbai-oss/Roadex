# Roadex

Roadex is a browser-first portal for server-hosted Codex sessions. It is intended to feel like using Codex locally on the server while the user connects from a desktop, tablet, or mobile browser.

The current implementation provides a secure responsive portal plus a server-side Codex runner for approved workspaces. Production access uses identity asserted by the Protected Service Gateway; mock authentication is available only when gateway authentication is not configured. Client device bridging remains behind a later security review gate.

## Structure

- `src/` - browser application source code
- `tests/` - automated tests
- `assets/` - project assets
- `docs/` - planning and contributor notes

## Commands

- `npm install` - install frontend dependencies.
- `npm run dev` - start the Vite development server and loopback Roadex API.
- `npm run dev:web` - start only the browser development server.
- `npm run dev:api` - start only the loopback Roadex API.
- `npm run build` - type-check and build the production bundle.
- `npm run lint` - run ESLint against the TypeScript source.
- `npm run test` - run the Vitest test suite.
- `npm start` - run the compiled server after `npm run build`.

## Codex Runner

Roadex starts Codex through the local CLI with:

```text
codex exec --json --sandbox workspace-write -C <approved-workspace> <prompt>
```

The default approved workspace is the Roadex server working directory. Set `ROADEX_WORKSPACE_ROOT` to point the demo workspace somewhere else, and set `ROADEX_CODEX_BIN` if the service should use a specific Codex binary.

For multiple server-approved projects, set `ROADEX_WORKSPACES_JSON` to a JSON array of `{ "id", "name", "root" }` records. Roadex accepts only those IDs from the browser; roots are never accepted from client requests.

The transcript toolbar lets authenticated users switch among approved projects and their own active or archived Roadex threads, or create a new thread in the selected project. Roadex-owned thread selection does not expose unrelated local Codex CLI history.

Runtime session, transcript, and audit metadata are written to `data/roadex-state.json` by default. The `data/` directory is ignored and must not be committed.

Prompt submission is asynchronous: `POST /api/sessions/:id/prompts` accepts work and the transcript is read from `GET /api/sessions/:id/stream` while Codex runs. Add `?live=1` for a long-lived SSE stream that sends the existing transcript followed by new runner events. The local API also supports `POST /api/sessions/:id/cancel` and `POST /api/sessions/:id/close`.

Archived sessions are listed through `GET /api/sessions` and restored through `POST /api/sessions/:id/reopen`. History is owner-scoped. Reopen preserves the session transcript and Codex thread, revalidates the workspace against current server policy, and is denied when that workspace already has an active session or stale runner state exists.

Roadex limits live streams per session to protect the long-lived endpoint. Set `ROADEX_MAX_STREAMS_PER_SESSION` to a positive integer to override the default of four. Rejected excess streams are recorded as security denial audit events. Bootstrap audit and transcript previews are scoped to the authenticated user; `admin` and `security-reviewer` roles may inspect the global audit tail, but not another user's session transcript.

## Protected Gateway

The production Roadex server is intended to run on loopback only at `127.0.0.1:8780`.
Remote browser access is through the Protected Service Gateway at:

```text
https://10.50.0.100:9443/Roadex
```

Use `ops/roadex.service` as the user systemd unit template after `npm run build`.

When Roadex is behind the Protected Service Gateway, both services should load the same ignored
`ROADEX_GATEWAY_SHARED_SECRET` from `local-secrets/roadex-gateway.env`. With that secret configured,
Roadex rejects mock login and accepts only gateway-stamped identity headers.

## Current Status

The repository contains the browser portal shell, protected-gateway deployment notes, and a real server-side Codex prompt runner. Client device and peripheral access are intentionally deferred until the core portal, session model, and security controls are working and verified.
