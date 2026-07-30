# Thread Recovery and Archive Deployment

## Approval Boundary

Source implementation and local verification do not authorize rebuilding or
restarting the live Roadex service. Deployment requires explicit approval to
rebuild and restart only `roadex.service` through Overseer.

No Protected Service Gateway, IDS, firewall, VPN, route, identity, MCP,
project-creation, repository, or project-file change is required. Recovery and
archive use the existing exact protected `reopen` and `close` routes.

## Behavior

- List active threads for the browsed project with accessible open and archive
  controls.
- Allow the owner to recover a blocked or paused thread only when no runner is
  active.
- Preserve the Roadex session ID, Codex thread ID, managed claim, and transcript
  during recovery.
- Never start a runner or submit a prompt during recovery.
- Refresh active and archived catalogs after archive so session capacity is
  immediately visible.
- Disable archive in the UI while a thread is streaming; explicit cancellation
  remains the supported way to stop active work.

## Verification

- Unit tests cover ownership, lifecycle, active-run denial, identity and
  transcript preservation, and structured conflicts through the protected
  reopen contract.
- Android Pixel 7 and iPhone 15 Playwright profiles cover mobile recovery,
  archive, persistent selection, fixed transcript scrolling, and overflow.
- Full unit, lint, build, and production dependency audit gates pass.
- The development dependency audit currently reports the upstream ESLint
  `brace-expansion` advisory and requires a separate breaking tooling upgrade.

## Rollback

Before rebuilding, preserve the current deployed `dist/` and `dist-server/`
output under ignored, permission-restricted local backup storage. Restore that
output and restart `roadex.service` if health or protected-gateway verification
fails.

No persistence migration is required. Older builds continue to read all
existing session records.

## Deployment Result

Approved and deployed on 2026-07-30 through Overseer plan
`admin.roadex-thread-recovery-archive-20260730`.

- Preflight found no active Codex runner child, so no directive was interrupted.
- The previously deployed `dist/` and `dist-server/` output was preserved under
  ignored, permission-restricted local deployment storage.
- The reviewed source rebuilt successfully and Overseer completed the
  `roadex.service` restart without invoking rollback.
- The service is active and `http://127.0.0.1:8780/api/health` returns success.
- `https://roadex.home.arpa:9443/Roadex` returns HTTP 200 through the protected
  gateway.
- The deployed server contains the recovery transition and exposes no new
  `/recover` route; the existing protected `reopen` and `close` routes remain
  the only affected route contracts.
- No prompt, session recovery, session archive, repository, gateway, IDS,
  firewall, route, or identity mutation was performed during deployment.

## Legacy Timeout Follow-Up

The first deployment exposed a lifecycle reconstruction mismatch for the
DonutHole session affected by the removed runner timeout. Persistence correctly
migrated that session to `ready`, but its immutable transcript still ended with
the legacy timeout and generic failure events. Thread selection reconstructed
those historical events as `blocked`, while the recovery endpoint saw the
authoritative session as already ready and returned the generic archived-session
404.

The follow-up source fix:

- preserves authoritative `ready` state only for the exact removed legacy
  timeout-plus-failure sequence;
- keeps genuine current failures and timeouts blocked;
- makes owner-scoped recovery idempotent when the session is already ready;
- still denies recovery whenever an active runner exists; and
- retains the existing protected `reopen` route without gateway or IDS changes.

Applying this follow-up requires a separately approved Roadex-only rebuild and
service restart.

The follow-up was approved and deployed on 2026-07-30 through Overseer plan
`admin.roadex-legacy-recovery-ui-fix-20260730`.

- Preflight again found no active Codex runner child.
- Overseer restarted `roadex.service` successfully without rollback.
- Loopback health and protected-gateway HTTP checks pass.
- The affected DonutHole session remains `ready` with no active run.
- The deployed client recognizes the exact legacy timeout recovery, and the
  deployed backend treats already-ready owner recovery as an idempotent success.
- No prompt was submitted and no transcript, thread identity, session ownership,
  gateway, IDS, firewall, route, or repository state was changed.
