# Device Bridge Pending-Request Intake Deployment

Date: 2026-07-18

Status: deployed and verified with pending-request intake enabled and device operations hard-disabled. Fail-closed MSI verification and complete audit correlation passed.

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

## Fail-Closed MSI Verification

The authenticated MSI smoke from `10.70.0.10` during the UTC window `2026-07-18T17:23:43.3054540Z` through `2026-07-18T17:23:46.3603627Z` used a schema-valid placeholder payload and verified:

- Gateway forwarded the request only after authenticated IDS acknowledgement.
- Roadex rejected the unbound placeholder with sanitized HTTP `502` reason `backend_denied`.
- IDS stored the redacted `bridge_request_authorized_to_forward` and `bridge_request_rejected` events.
- The backend-denial event matched one explicit gateway success record and one durable replay row.
- Gateway telemetry spool remained empty.
- Roadex retained zero requests, approvals, and operations.
- Bootstrap succeeded before and after the request, preserving the active session, workspace, lifecycle, and thread.

Gateway commit `bbd35a5` adds the positive success record for the pre-forward authorization event. The gateway-only restart and MSI repeat completed under the approved intake deployment scope.

## Audit-Correlation Retest

The authenticated MSI repeat from `10.70.0.10` during the UTC window `2026-07-18T17:26:28.1993318Z` through `2026-07-18T17:26:30.8231709Z` verified:

- Two unique gateway `ids_forwarding_succeeded` records.
- A one-to-one event-ID match with the IDS pre-forward authorization and backend-denial events.
- Two matching durable IDS replay rows.
- Gateway telemetry spool remained empty.
- Roadex retained zero requests, approvals, and operations.
- Bootstrap succeeded before and after the fail-closed request, preserving the active session, workspace, lifecycle, and thread.

The pending-request intake deployment is complete. Creating a valid pending request remains blocked until a server-produced firmware artifact and owner-approved inventory binding are implemented and separately approved.
