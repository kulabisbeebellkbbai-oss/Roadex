# Controlled Runner Automatic Enrollment Deployment

## Approval Boundary

Source implementation and local verification are complete. This document
requests separate approval to rebuild and restart only the existing loopback
`roadex.service`. It does not change Protected Service Gateway, IDS, firewall,
VPN, routes, identities, project-creation flags, static allowlists, or GitHub
state.

## Planned Change

1. Record the current Roadex service status and deployed build identity.
2. Preserve a timestamped local rollback copy of the current `dist/` and
   `dist-server/` output without adding it to Git.
3. Rebuild Roadex from the reviewed working tree.
4. Restart `roadex.service` through Overseer coordination.
5. Verify loopback health, protected-gateway page/bootstrap health, and logs.
6. Verify an existing controlled DonutHole thread still receives the controlled
   profile through the static compatibility path.
7. Exercise automatic grants only with temporary local broker state. A new live
   project creation is not part of this deployment.

## Expected Effect

Future projects that successfully reach the durable project-creation
`completed` phase will receive an exact server-owned controlled-runner grant.
They will be able to use the fixed A-Team, Skiller, and bounded Overseer tools
without adding a workspace ID to systemd configuration or restarting Roadex.

Existing sessions and project files are preserved. Pending, failed, mismatched,
revoked, unmanaged, and neighboring sessions remain restricted.

## Rollback

Restore the preserved `dist/` and `dist-server/` output and restart only
`roadex.service`. The project-creation database migration is additive. A
rollback build ignores the new nullable operation columns and grant table; no
destructive schema rollback is required.

## Verification Evidence

- `npm test`: 28 files, 235 tests passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm audit --omit=dev`: zero vulnerabilities.
- `npm run test:mobile`: six tests passed using Android Pixel 7 and iPhone 15
  emulation.
- `git diff --check`: passed.

## Deployment Result

Approved and deployed on 2026-07-29 through Overseer plan
`admin.roadex-controlled-auto-enrollment-20260729`.

- A permission-restricted rollback copy of the prior deployed output is stored
  under `local-secrets/backups/` and remains outside Git.
- The rebuild passed and Overseer completed the `roadex.service` restart.
- `roadex.service` is active and the loopback health endpoint returns success.
- `https://roadex.home.arpa:9443/Roadex` returns HTTP 200 through the protected
  gateway.
- The deployed bundle contains the durable grant resolver.
- The live safe-profile evaluation selects `controlled-project-manager` for the
  exact DonutHole workspace and `restricted` for a neighboring workspace.
- No prompt, project creation, gateway change, IDS change, or project-state
  mutation was performed during deployment verification.
