# Device Bridge Default-Off Deployment Record

Deployment completed on 2026-07-18 under the approved default-off scope.

## Revisions

- Roadex: `3c9c8ef124964fbb68e90d797f02e03ed124fba9`
- Protected Service Gateway: `afb2fc7ec18c9ebb6f36c177f30e9a8136c4a615`

## Release And Rollback Artifacts

Owner-only Roadex artifacts:

```text
local-secrets/deployments/20260718T154633Z/
```

Owner-only gateway artifacts:

```text
../Protected Service Gateway/local-secrets/deployments/20260718T154633Z/
```

Each directory contains release archives, previous-revision rollback archives, service/environment backups, and `SHA256SUMS`. Secret-bearing files and checksum values are not copied into this public document.

## Configuration

- Separate Roadex and gateway audit HMAC keys were generated into existing ignored owner-only environment files.
- Key values were not printed or committed.
- Roadex request intake is false.
- Roadex operations are false and remain hard-disabled in production code.
- Gateway request intake is false.
- Gateway operations are false and rejected by configuration validation if enabled.
- No firewall, IDS rule, VPN, NAT, source, port, listener, or Permissions-Policy grant changed.

## Verification

- `roadex.service` restarted independently and is healthy on `127.0.0.1:8780`.
- Direct protected-gateway identity smoke received the uniform `403` device-bridge denial while intake was false.
- `protected-service-gateway.service` restarted independently and serves HTTPS on `10.50.0.100:9443`.
- TLS negotiated TLS 1.3.
- No `0.0.0.0`, Wi-Fi-address, or IPv6 listener exists on the gateway port.
- Runtime environment inspection confirmed the expected audit key is present in each service and both Roadex flags are false.
- The Intrusion Detection receiver accepted a redacted synthetic bridge-denial event, returned an acknowledgement fingerprint, and exposed the matching event through its recent-event query.

## Remaining Gates

- The gateway has no automatic JSONL-to-IDS forwarding process. Receiver ingestion was verified with a one-shot redacted event only.
- Authenticated Roadex bootstrap/session/SSE regression and exact bridge denial through the gateway require the approved MSI VPN source and its authenticated browser session.
- Request intake remains disabled. Enabling it requires a separate reviewed source/configuration change because the gateway flag is deliberately hard false in this deployment.
- No device chooser, USB/serial access, artifact delivery, operation route, firmware data, or flashing is available.

## Next Approval Boundary

Before request-intake enablement:

1. Complete the authenticated MSI default-off smoke and correlate gateway/Roadex logs without exposing cookies or tokens.
2. Design and review authenticated automatic forwarding of redacted bridge events to the IDS receiver, including receiver authentication and acknowledgement/failure behavior.
3. Prepare an exact enablement patch that changes only the one request-intake gate and keeps all operation paths hard-disabled.
4. Run local denial/allow boundary tests, security review, and a separate enablement approval.
