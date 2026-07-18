# Device Bridge Metadata Registry Default-Off Deployment

Date: 2026-07-18

Status: deployed with the metadata registry disabled.

## Deployed Revision

- Roadex: `c194d3e38089263e938be50af5de2a6ec75ecdee`
- Gateway isolation tests: `eec2814701a6f9e3c3d20e5d6627199c0e10f744`

## Rollback Evidence

Checksummed owner-only Roadex artifacts are stored under:

```text
local-secrets/deployments/20260718T175842Z-metadata/
```

The directory contains current and previous source archives, the prior service
environment, the service unit, the prior persisted state when present, and
`SHA256SUMS`. Secret values and checksum contents are not recorded here.

## Configuration Boundary

- `ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED=false`
- A separate `ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY` is present in the ignored
  owner-only environment file.
- Pending-request intake remains enabled from the previously approved phase.
- Device operations remain disabled.
- No gateway route, listener, firewall, IDS, VPN, NAT, USB, artifact delivery,
  approval, operation, or flashing capability changed.

## Local Verification

- Roadex restarted successfully and listens only on `127.0.0.1:8780`.
- The browser portal root returned HTTP 200.
- An authenticated direct metadata registration attempt returned HTTP 403 with
  the `device-bridge` gate and classification while the registry was disabled.
- Persisted state retained no artifacts, inventory bindings, approvals, or
  operations.
- Service logs showed a clean stop and start with no startup error.

## External Verification Boundary

The remaining check requires the approved MSI VPN source and an authenticated
Roadex browser session. Verify that the portal and bootstrap remain available,
the metadata and inventory routes remain blocked by the gateway, the existing
session and thread remain unchanged, and no bridge records are created.

