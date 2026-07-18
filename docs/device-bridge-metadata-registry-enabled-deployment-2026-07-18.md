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

An authenticated MSI-origin smoke is still required after enablement. It must
confirm that both public metadata and inventory-binding routes remain rejected
by the gateway, authentication remains healthy, the existing session and thread
are preserved, and Roadex bridge state remains empty.

