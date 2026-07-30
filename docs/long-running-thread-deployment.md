# Long-Running Thread Deployment

## Approval Boundary

Source implementation and local verification do not authorize restarting the
live Roadex service. Deployment requires explicit approval to rebuild and
restart only `roadex.service` through Overseer.

No Protected Service Gateway, IDS, firewall, VPN, route, identity, MCP,
project-creation, repository, or project-file change is required.

## Behavior

- Remove the fixed Codex runner wall-clock deadline.
- Continue supervising each child until process completion, failure, or an
  explicit owner cancellation.
- Preserve the global active-run concurrency bound.
- Track bounded active-run timestamps only in owner-scoped session state.
- Display a small accessible `Working` indicator while the selected thread is
  active.
- Keep desktop and mobile transcripts in fixed responsive scroll viewports.
- Remember the selected opaque session ID across reload and accept it only
  when it exactly matches a current owned active session.

## Rollback

Preserve the current deployed `dist/` and `dist-server/` output under ignored,
permission-restricted local backup storage before rebuilding. Restore that
output and restart `roadex.service` if health or protected-gateway verification
fails.

No state migration is required. Older builds ignore the optional in-memory
activity field.

## Deployment Result

Approved and deployed on 2026-07-30 through Overseer plan
`admin.roadex-long-running-threads-20260730`.

- Preflight found no active Codex runner child, so no live directive was
  interrupted by the restart.
- The exact prior commit `799ace5` was rebuilt into ignored,
  permission-restricted local rollback storage.
- The reviewed source rebuilt successfully and Overseer completed the
  `roadex.service` restart.
- The service is active and the loopback health endpoint returns success.
- `https://roadex.home.arpa:9443/Roadex` returns HTTP 200 through the protected
  gateway.
- The deployed runner contains activity supervision and no longer contains the
  fixed timeout configuration or timeout termination path.
- A narrow follow-up migration was deployed through Overseer plan
  `admin.roadex-legacy-timeout-recovery-20260730`. It restores only a blocked
  session whose latest terminal sequence is the removed legacy timeout followed
  by the generic failure marker; unrelated failures remain blocked.
- The original timeout-affected DonutHole session is present and resolves to
  `ready` when loaded by the deployed persistence code.
- No prompt, repository, project, gateway, IDS, firewall, route, or identity
  mutation was performed during deployment.
