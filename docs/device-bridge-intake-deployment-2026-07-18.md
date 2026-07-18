# Device Bridge Pending-Request Intake Deployment

Date: 2026-07-18

Status: deployed with pending-request intake enabled and device operations hard-disabled. Authenticated MSI-origin verification remains pending.

## Deployed Scope

- Roadex commit `5cefc3c` accepts only literal `true` for `ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED` and retains hard-disabled operations.
- Protected Service Gateway commit `210c704` accepts the same strict intake flag and still requires healthy authenticated IDS forwarding before forwarding the exact request route.
- The only bridge route exposed remains `POST /Roadex/api/sessions/:sessionId/device-bridge/requests`.
- Approval issuance, operation creation, artifact delivery, probing, USB access, firmware transfer, and flashing remain unavailable.
- No firewall, VPN, NAT, Suricata, listener, port, source-allowlist, or key change was made.

## Rollback Evidence

Checksummed owner-only artifacts are stored under deployment stamp `20260718T171956Z-intake`:

- Roadex: `/home/god/Documents/Codex Workspace/Roadex/local-secrets/deployments/20260718T171956Z-intake/`
- Gateway: `/home/god/Documents/Codex Workspace/Protected Service Gateway/local-secrets/deployments/20260718T171956Z-intake/`

The Roadex archive includes source, server, tests, built artifacts, predeployment state, environment file, and service unit. The gateway archive includes source, tests, project metadata, environment file, and service unit.

## Local Verification

- Roadex tests, lint, and production build passed before deployment.
- Gateway tests and compile checks passed before deployment.
- Independent security review found no blocking source/local-test findings.
- `roadex.service` restarted independently and retained `127.0.0.1:8780`.
- `protected-service-gateway.service` restarted independently and retained TLS on `10.50.0.100:9443`.
- Both running processes have pending-request intake enabled.
- Gateway IDS forwarding keys and spool health validated without exposing key material.
- Roadex and gateway device-operation controls remain false.
- Production Roadex state contains no device artifact, inventory binding, pending request, approval, or operation.

## External Verification Boundary

The approved MSI-origin smoke must verify:

- Bootstrap reports request intake enabled and operations disabled.
- An authenticated request with the exact Origin and CSRF header reaches the enabled gateway path.
- Because no production artifact or inventory binding exists, Roadex rejects the request without creating a pending request, approval, or operation.
- Gateway and IDS records correlate through the authenticated forwarding event ID.
- Gateway telemetry spool remains empty.
- The active Roadex session, workspace, lifecycle, and thread remain unchanged.

A successful pending-request creation test requires a separately reviewed server-produced firmware artifact and owner-approved inventory binding. This deployment does not authorize inventing or registering those values.
