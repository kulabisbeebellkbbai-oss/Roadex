# Device Bridge Request Intake Deployment Approval

Status: staged only. No action in this document is approved or executed.

## Completed Code Phase

- Roadex implements one pending-request endpoint with separate default-off intake policy and hard-disabled operations.
- Protected Service Gateway implements one exact prefixed bridge route, default-off routing, gateway-owned expiring CSRF tokens, strict framing/schema checks, atomic rate limits, fail-closed identity and audit keys, uniform backend denials, and redacted durable audit events.
- Approval issuance, operation creation, artifact delivery, probing, events, cancellation, browser hardware APIs, and firmware writing remain unavailable.
- Local Roadex tests, lint, and production build pass. Local gateway tests pass. Security review has no remaining code-phase findings.

## Proposed Deployment Sequence

The following remains unapproved:

1. Commit and identify the reviewed Roadex and gateway source revisions.
2. Build Roadex in its checkout and record SHA-256 checksums for `dist/` and `dist-server/` release archives.
3. Build a gateway source archive and record its SHA-256 checksum.
4. Back up the current Roadex and gateway deployed artifacts, user service files, non-secret configuration, and state schemas to a timestamped owner-only directory.
5. Provision separate owner-only secrets without printing them:
   - `ROADEX_GATEWAY_AUDIT_HMAC_KEY`
   - `ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY`
6. Install both reviewed builds with all bridge flags still false.
7. Restart only `roadex.service`; verify loopback health, bootstrap, session creation, prompt, SSE, archive, reopen, and listener `127.0.0.1:8780`.
8. Restart only `protected-service-gateway.service`; verify TLS, existing protected services, listener `10.50.0.100:9443`, no unexpected IPv4/IPv6 listeners, and that every bridge path is rejected while intake is false.
9. Verify authenticated gateway/Roadex security-event forwarding and receiver acknowledgement using denial-only local tests.
10. Request a separate enablement approval before setting both request-intake flags true. Operations remain hard-disabled.

No firewall, IDS rule, VPN, NAT, source allowlist, port, listener, or browser Permissions-Policy change is proposed.

## Exact Configuration Boundary

Roadex deployment keeps:

```text
ROADEX_DEVICE_BRIDGE_REQUEST_INTAKE_ENABLED=false
ROADEX_DEVICE_BRIDGE_OPERATIONS_ENABLED=false
```

Gateway deployment keeps:

```text
roadex_device_bridge_request_intake_enabled = False
roadex_device_bridge_operations_enabled = False
```

Dedicated audit HMAC keys are required before the bridge route can process a mutation. Existing gateway shared-secret, TLS key, cookies, authenticators, and local state are not copied into source control or printed.

## Verification Commands

Run only after deployment approval:

```bash
cd '/home/god/Documents/Codex Workspace/Roadex'
npm test
npm run lint
npm run build

cd '/home/god/Documents/Codex Workspace/Protected Service Gateway'
python3 -m pytest

systemctl --user restart roadex.service
systemctl --user status roadex.service --no-pager
systemctl --user restart protected-service-gateway.service
systemctl --user status protected-service-gateway.service --no-pager
ss -ltnp
```

Health and denial smoke commands must omit cookies, CSRF values, shared secrets, audit keys, raw device identity, and firmware data from output and logs.

## Later Enablement Gates

Request-intake enablement requires another approval after:

- deployed default-off denial behavior is verified locally;
- alert forwarding and acknowledgement pass;
- packet/log correlation proves the gateway receives the assigned VPN tunnel source rather than a translated address;
- exact build checksums, backups, configuration paths, and rollback commands are recorded;
- MSI authentication is re-established for an approved outside smoke.

Enablement still exposes only:

```text
POST /Roadex/api/sessions/:sessionId/device-bridge/requests
```

Every other bridge route remains blocked.

## Rollback

1. Keep or restore both intake flags false and confirm operations remain hard-disabled.
2. Remove pending request records with the reviewed schema-compatible cleanup command prepared before deployment.
3. Restore the backed-up Roadex artifact and restart only `roadex.service`.
4. Restore the backed-up gateway artifact and restart only `protected-service-gateway.service`.
5. Verify every bridge path is rejected, existing protected services work, TLS is active, audit forwarding works, and listeners are only `127.0.0.1:8780` and `10.50.0.100:9443`.
6. Stop both services only for an active exposure or authorization incident; preserve only redacted incident records.

## Approval Requested

Approve default-off deployment preparation and execution: create checksummed release archives and backups, provision the two dedicated audit HMAC keys securely, install reviewed builds with all bridge flags false, restart each service separately, and perform local denial/health/alert verification.

This approval would not enable request intake, permit MSI testing, change network policy, expose additional routes, access hardware, deliver firmware, or authorize flashing.
