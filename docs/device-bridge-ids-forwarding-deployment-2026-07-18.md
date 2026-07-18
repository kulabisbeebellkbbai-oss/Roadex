# Device Bridge IDS Forwarding Deployment

Date: 2026-07-18

Status: deployed and authenticated MSI-origin default-off verification passed. Device-bridge request intake and operations remain disabled. A gateway-only restart is pending to activate explicit positive forwarding audit records added after correlation.

## Deployed Scope

- Protected Service Gateway commit `9d0dae4edf43d2f5e497b0d22b888eedcebc8457`.
- IDS receiver source adds authenticated `POST /gateway-events` on the existing `10.50.0.100:8088` listener.
- Gateway forwards strict redacted bridge events to the fixed receiver endpoint and requires a request-bound durable acknowledgement.
- Directionally separate request and acknowledgement HMAC keys are stored only in owner-readable environment files.
- Gateway forwarding and its bounded telemetry drainer are enabled.
- Receiver gateway-event intake is enabled and pins the actual socket peer to `10.50.0.100`.
- Device-bridge request intake and device operations remain disabled.
- No firewall, VPN, NAT, Suricata, bind, port, or source-allowlist change was made.

## Rollback Evidence

Checksummed owner-only artifacts are stored under deployment stamp `20260718T165520Z`:

- Roadex/IDS: `/home/god/Documents/Codex Workspace/Intrusion Detection/local-secrets/deployments/20260718T165520Z/`
- Gateway: `/home/god/Documents/Codex Workspace/Protected Service Gateway/local-secrets/deployments/20260718T165520Z/`

The IDS archive includes source, tests, receiver documentation, the prior service unit, and predeployment event data. The gateway archive includes source, tests, project metadata, the prior owner-only environment file, and service unit.

## Local Verification

- IDS receiver restarted independently and retained its existing UDP `5514` and HTTP `8088` listeners on `10.50.0.100`.
- Gateway restarted independently and retained its HTTPS `9443` listener on `10.50.0.100`.
- Roadex returned HTTP `200` through the TLS gateway.
- Unauthenticated receiver gateway-event intake returned the uniform HTTP `403` denial.
- A redacted authenticated host-origin event received a durable acknowledgement and was stored as `bridge_request_rejected` with reason `request_intake_disabled`.
- Gateway key configuration and spool health checks passed without exposing key material.
- Gateway device-bridge request intake and operations remained false.
- No telemetry record remained queued after the successful authenticated forwarding check.

## External Verification

The approved VPN source `10.70.0.10` completed an authenticated browser-origin smoke during the UTC window `2026-07-18T17:00:04.3185070Z` through `2026-07-18T17:00:05.4776363Z`:

- Bootstrap returned HTTP `200` before and after the request.
- The bridge request returned HTTP `403` with `Cache-Control: no-store`, error `device_bridge_rejected`, and reason `request_intake_disabled`.
- The authenticated Roadex session, workspace, lifecycle, and thread were preserved.
- Gateway structured logs contained the normalized bootstrap, denial, and follow-up bootstrap sequence.
- IDS stored exactly one matching durable `bridge_request_rejected` event and one replay record.
- The IDS event contained only the approved redacted schema and reason `request_intake_disabled`.
- Roadex retained zero bridge requests, approvals, and operations.
- Gateway telemetry spool remained empty.

The server clock led the client-reported timestamps by approximately one to two seconds; correlation used a slightly widened window.

## Follow-Up Audit Improvement

Gateway commit `ed012c0` adds an explicit local `ids_forwarding_succeeded` record after a denied event receives its authenticated durable IDS acknowledgement. The full gateway suite passes with this behavior. A separately approved gateway-only restart is required to activate it; no receiver, network, key, or feature-flag change is required.

Activating the audit improvement and any later request-intake enablement require separate approvals.
