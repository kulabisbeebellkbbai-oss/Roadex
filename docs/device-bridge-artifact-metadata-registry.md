# Device Bridge Artifact Metadata Registry

This slice is disabled by default. The registry is available only when
`ROADEX_DEVICE_BRIDGE_METADATA_REGISTRY_ENABLED=true` and
`ROADEX_DEVICE_BRIDGE_AUDIT_HMAC_KEY` is set to a strong application audit HMAC
key. Inventory binding also requires the separate
`ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY`; the audit key is never reused for
device identity pseudonyms. Unset, `false`, or malformed boolean values fail
closed, and missing HMAC keys fail the affected mutation closed.

## Firmware Artifact Metadata

The Roadex server may register firmware artifact metadata for an authenticated
owner session. The request body contains only a constrained project-relative
artifact path and optional filename-safe `.bin` label. Roadex resolves that path
beneath the authorized workspace root, rejects traversal, absolute paths,
symlink components, non-files, non-`.bin` formats, empty files, and oversized
files, then computes byte length and SHA-256 from the server-side file.

Roadex opens the file without following the final symlink, validates the open
descriptor, resolves `/proc/self/fd/<fd>` while the descriptor is still open,
requires the target to remain under the real workspace root, hashes through the
descriptor, and rejects the artifact if file identity or size changes while it is
being read.

Roadex generates the artifact id, media type, format, timestamps, expiry, and
opaque storage reference. It never accepts client-supplied byte length, digest,
media type, format, storage reference, or filesystem path for persistence. The
storage reference is persisted internally only; register, list, and revoke
responses return a public artifact DTO that omits it.

Roadex does not expose artifact bytes, download/retrieval routes, browser USB
or serial choosers, approvals, device operations, or flashing in this workflow.

## Inventory Binding

Inventory binding is restricted to protected-gateway users with owner/security
authorization. The request must select a server-approved project, the approved
operation enum, and secure-boot plus flash-encryption expectations. Device
identity input is normalized, domain-separated, converted to an application HMAC
pseudonym with `ROADEX_DEVICE_BRIDGE_IDENTITY_HMAC_KEY`, and then discarded; raw
MAC, serial, or USB strings are not retained.

Bindings are lifecycle-managed and revocable. Artifact and binding mutations are
persisted atomically with redacted audit records so failed persistence leaves no
in-memory request, binding, artifact, or audit mutation behind.
