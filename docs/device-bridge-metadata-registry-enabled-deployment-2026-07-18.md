# Device Bridge Metadata Registry Enabled Deployment

Date: 2026-07-18

Status: enabled on the loopback Roadex backend; external metadata and inventory
routes remain blocked by the protected gateway.

## Deployed Revision

- Roadex feature: `c194d3e38089263e938be50af5de2a6ec75ecdee`
- Gateway isolation tests: `eec2814701a6f9e3c3d20e5d6627199c0e10f744`

## Rollback Evidence

Checksummed owner-only artifacts are stored under:

```text
local-secrets/deployments/20260718T181146Z-metadata-enabled/
```

The bundle contains the pre-enable environment, persisted state, service unit,
release archive, and checksums. Secret values and checksum contents are not
recorded here.

## Runtime Boundary

- Metadata registry is enabled on the Roadex loopback backend.
- Pending-request intake remains enabled from the prior approved phase.
- Device operations remain disabled.
- The identity pseudonym key remains separate from the audit key.
- No gateway route, listener, firewall, IDS, VPN, NAT, USB, artifact delivery,
  approval, operation, or flashing capability changed.

## Local Lifecycle Verification

An authenticated localhost smoke used a temporary server-side `.bin` file and
a synthetic non-production identity.

- Artifact registration returned HTTP 201 and listing returned HTTP 200.
- Roadex computed the artifact length and SHA-256 from the opened server file.
- The internal storage reference was absent from registration, listing, and
  revocation responses.
- Inventory binding creation returned HTTP 201 and listing returned HTTP 200.
- Raw synthetic identity was not returned or persisted; only its full
  domain-separated HMAC pseudonym was stored.
- Inventory and artifact revocation both returned HTTP 200.
- No bridge request, approval, or operation was created.
- The temporary artifact was deleted and the exact pre-test persisted state was
  restored before Roadex restarted.
- Production state contains no artifact, binding, request, approval, or
  operation records after the smoke.

## External Verification Boundary

Completed from the approved MSI VPN source during the UTC window
`2026-07-18T18:16:44.1948948Z` through `2026-07-18T18:16:46.1018409Z`.

- The portal and bootstrap returned HTTP 200 and the CSRF response header was
  available to the authenticated helper without being printed.
- Artifact metadata and inventory-binding POST requests both returned HTTP 404,
  `Cache-Control: no-store`, `device_bridge_rejected`, and
  `bridge_route_not_allowed`.
- Follow-up authentication succeeded and preserved the session, workspace,
  lifecycle, and thread.
- Artifact, inventory-binding, bridge-request, approval, and operation counts
  remained zero.
- Gateway records contain both route rejections, matching successful IDS
  forwarding records, and the allowed follow-up bootstrap.
- Roadex received neither prohibited route and its persisted bridge state
  remained empty.

The Windows helper again reported Schannel missing-close-notify warnings after
both complete rejection responses. Status, headers, and bodies were received,
so the warnings did not invalidate the smoke. Graceful TLS shutdown remains a
separate transport-hardening follow-up.
