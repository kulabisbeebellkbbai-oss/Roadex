# Device Bridge IDS Forwarding Approval Plan

Status: staged proposal only. Do not implement or deploy without explicit approval.

## Verified Current State

- Default-off MSI smoke reached the gateway from `10.70.0.10` and produced a normalized `bridge_request_rejected` record with reason `request_intake_disabled`.
- Roadex received no mutation and retained no bridge request, approval, or operation.
- The Intrusion Detection receiver accepted and acknowledged a one-shot redacted synthetic event.
- No event from the MSI smoke arrived automatically at the receiver.
- The receiver currently exposes unauthenticated `POST /events` on `10.50.0.100:8088`; it must not be used as the production gateway-forwarding contract.

## Proposed Authenticated Contract

Add a dedicated receiver endpoint:

```text
POST http://10.50.0.100:8088/gateway-events
```

Requirements:

- Reuse the existing IDS HTTP listener and add no bind, port, proxy, firewall, VPN, or NAT change. The gateway and receiver are on the same host and use direct HTTP to the host's existing static service address. The event payload is strictly redacted but is not transport-encrypted; request and acknowledgement HMACs provide integrity and mutual possession proof, not confidentiality. A later TLS migration requires separate approval.
- Accept only actual socket peer `10.50.0.100`; never substitute a forwarding header for the peer and reject every forwarding/proxy header. The integration test must fail unless the real host route presents that exact peer.
- Require exactly `application/json`, exactly one decimal `Content-Length` from 1 through 8192, at most 24 headers and 8192 total header bytes, and no line longer than 2048 bytes. Reject transfer encoding, duplicate security headers, invalid UTF-8, trailing data, and body reads exceeding 2 seconds.
- Permit at most 8 concurrent `/gateway-events` requests. Per socket-peer address, allow 30 accepted events per 60 seconds and 10 authentication failures per 60 seconds, then return a constant-size `429` response. Reject source and content type before reading a body, and use the same constant-size `403` body for all authentication failures. Advisory generation must run outside receiver request threads.
- Authenticate every exact raw request body with a separate key decoded from base64 to exactly 32 random bytes. Store it in owner-only environment files under `ROADEX_IDS_FORWARDING_HMAC_KEY`; require a non-secret key ID and reject startup or requests when key configuration is missing, malformed, weak, or unknown.
- Require exactly one each of `X-Roadex-Event-Key-Id`, `X-Roadex-Event-Timestamp`, `X-Roadex-Event-Nonce`, and `X-Roadex-Event-Signature`. Define the nonce as 32 lowercase hexadecimal characters.
- Sign the exact raw bytes of `timestamp + newline + nonce + newline + body` using HMAC-SHA-256 and compare in constant time before parsing JSON. Never log authentication headers, signatures, nonces, or rejected bodies.
- Use wall time only for a plus-or-minus 60-second skew check. Persist the authenticated replay key `(key_id, event_id)` transactionally with the event. A backward wall-clock movement greater than 5 seconds closes authenticated intake until a monotonic health check observes valid wall time for 60 consecutive seconds.
- A duplicate event ID with the same body digest returns the same deterministic acknowledgement. Reuse with a different digest is rejected, recorded, and alerted.
- Parse with duplicate-key detection and accept exactly this flat allowlist schema: `schema_version`, `event_type`, `event_timestamp`, `event_id`, `reason`, `status`, `method`, `normalized_route`, `size_bucket`, `source_hash`, `account_hash`, and `vpn_client_hash`. Reject unknown or missing fields, nested values, arrays, arbitrary strings, floats, non-finite values, booleans where integers are required, and non-canonical encodings.
- Use `schema_version=1`; integer Unix seconds from 0 through 4102444800; HTTP status from 100 through 599; event ID as 32 lowercase hexadecimal characters; and each pseudonym as 64 lowercase hexadecimal characters.
- Permit only these enums:
  - `event_type`: `bridge_request_rejected`, `bridge_request_authorized_to_forward`, `bridge_request_backend_confirmed`, `ids_forwarding_failed`, `ids_replay_rejected`, `ids_signature_rejected`, `ids_schema_rejected`, `ids_spool_overflow`, `ids_identity_mismatch`, `ids_policy_drift`, `ids_bind_drift`, `ids_tls_drift`, `ids_csrf_rejected`.
  - `reason`: `allowed`, `request_intake_disabled`, `operations_disabled`, `invalid_route`, `invalid_origin`, `invalid_csrf`, `unauthenticated`, `unauthorized`, `rate_limited`, `body_too_large`, `schema_invalid`, `signature_invalid`, `replay_detected`, `event_id_conflict`, `receiver_unavailable`, `ack_invalid`, `spool_full`, `identity_mismatch`, `policy_drift`, `bind_drift`, `tls_drift`, `backend_rejected`, `backend_succeeded`.
  - `method`: `POST`.
  - `normalized_route`: `/Roadex/api/sessions/:sessionId/device-bridge/requests`.
  - `size_bucket`: `none`, `1-1024`, `1025-4096`, `4097-8192`, `over-limit`.
- Reject raw paths, queries, principals, VPN labels, session/object IDs, cookies, authorization/CSRF values, device identity, firmware, and free text.
- Return canonical compact JSON with keys in this exact order: `event_id`, `body_sha256`, `stored`, `receiver_id`, `key_id`. Values are the request event ID, 64-character lowercase request-body SHA-256, literal `true`, fixed receiver ID `roadex-ids-1`, and the acknowledgement key ID.
- Authenticate acknowledgements with a separate base64-decoded 32-byte `ROADEX_IDS_ACK_HMAC_KEY`; never reuse the request key. Return exactly one `X-Roadex-Ack-Key-Id` and one `X-Roadex-Ack-Signature`, where the lowercase hexadecimal signature is HMAC-SHA-256 over the exact response body. The gateway validates key ID, exact canonical body, request bindings, receiver ID, and signature in constant time.
- A successful acknowledgement is exactly HTTP `201` with exactly `Content-Type: application/json`, exactly one decimal `Content-Length` matching the body, no `Transfer-Encoding`, no informational response, no redirect, and no trailing bytes. The canonical body must be no larger than 512 bytes. Reject duplicate acknowledgement headers, more than 24 response headers, more than 8192 total response-header bytes, any header line over 2048 bytes, any mismatched length, or any response body exceeding 512 bytes before authentication.
- No other status is a successful acknowledgement. Error responses are never parsed as acknowledgements and cannot authorize forwarding.
- During rotation, sign new requests and acknowledgements with one configured current key ID and accept only that ID plus one explicitly configured previous ID for 24 hours. Unknown IDs fail closed. Remove the previous key only after the retry spool contains no record signed by it.

## Default-Off Configuration

- Add gateway flag `ROADEX_IDS_FORWARDING_ENABLED=false` and receiver flag `ROADEX_IDS_GATEWAY_EVENTS_ENABLED=false`. Both default false when absent and reject malformed values.
- When receiver flag is false, `/gateway-events` returns constant-size `404` without reading a body. Existing `/events` behavior is unchanged.
- Gateway request intake remains closed unless its existing intake flag is true, IDS forwarding is true, key configuration is valid, and the spool is below limits. Every individual mutation still remains closed until its own event receives the fresh authenticated durable acknowledgement defined above; no separate health endpoint or cached health result can authorize forwarding.
- Tests inject flags and generated keys into isolated process environments only. Source implementation must not alter production environment files, service units, or running processes.

## Fail-Closed Gateway State Machine

- For every intake-enabled mutation, perform only this order:
  1. Validate route, headers, authenticated session, CSRF, rate limit, and bounded body.
  2. Construct and validate the strict redacted event with a stable event ID and digest.
  3. Durably append and `fsync` the owner-only local gateway event.
  4. Send the event directly to the fixed HTTP URL with a 2-second connect timeout and 3-second total timeout, no redirects, no environment proxy use, and no alternate address.
  5. Validate the receiver signature, identity, event ID, body digest, key ID, and durable storage result.
  6. Only after the authenticated durable acknowledgement, forward the original body to Roadex.
- No backend mutation route may bypass this gate. Log `bridge_request_authorized_to_forward` separately from `bridge_request_backend_confirmed`; the first is not evidence that Roadex mutated state.
- Any missing, invalid, delayed, or mismatched acknowledgement fails closed before Roadex body forwarding or state mutation.
- For already-denied requests, preserve the denial response and append a local `ids_forwarding_failed` event without recursively forwarding that failure event.
- A retry spool carries telemetry only. Draining a blocked event must never replay or authorize the original Roadex mutation.

## Telemetry Spool

- Store only strict redacted events with stable event ID, digest, key ID, and signature. Never store request bodies, request headers, raw identifiers, secrets, or executable mutation instructions.
- Create records atomically in an owner-only directory using a same-directory temporary regular file, fixed permissions, `O_NOFOLLOW`, link-count/type checks, file `fsync`, atomic rename, and directory `fsync`.
- Enforce at most 1000 records and 8 MiB total, whichever is reached first, with a single locked drainer. Quarantine malformed records. Retry after 1, 2, 4, 8, 16, 30, then 60 seconds and remain at 60 seconds. Never silently evict evidence.
- Spool overflow keeps mutation intake closed and emits a local non-recursively-forwarded alert.
- Support verification with the current and explicitly retained previous key IDs during controlled rotation; never delete old-key records merely because rotation occurred.

## Receiver And Alert Behavior

- Store the normalized event through the existing EventStore. Success requires JSONL write, flush, and `fsync`, followed by a committed SQLite transaction containing the event and unique replay key. Return no successful acknowledgement after either failure.
- Make event ID unique in SQLite. Add startup and repair reconciliation for partial JSONL/SQLite writes, with tests proving retry idempotence and recovery after interruption at each persistence boundary.
- Use explicit bridge-event types and aggregation keys, not keyword scanning. Mark policy, audit, identity, bind/TLS, replay, signature, and spool-overflow events high; destructive-route attempts and repeated CSRF failures medium; schema rejection low unless repeated. Aggregate by `(event_type, reason, source_hash)` in 60-second windows.
- Aggregate malformed route, content-type, and limiter noise by pseudonym and reason to avoid alert flooding.
- Count and aggregate authentication failures locally; never include supplied signatures, nonces, bodies, or secrets in tickets or responses.
- Keep advisory response behavior read-only and approval-gated.
- Existing unauthenticated `/events` remains for its current uses but is not accepted as proof of authenticated gateway forwarding. A later review should decide whether to restrict it separately.

## Files And Services Proposed

Protected Service Gateway:

- `src/protected_service_gateway/gateway.py`
- new focused forwarding module under `src/protected_service_gateway/`
- `tests/`
- no production or local secret environment-file creation or modification in this phase
- `protected-service-gateway.service` restart only after a later deployment approval

Intrusion Detection:

- `src/intrusion_detection/receiver.py`
- `src/intrusion_detection/classifier.py` only if required for explicit bridge classifications
- `tests/`
- no production or local secret environment-file creation or modification in this phase
- `intrusion-detection-receiver.service` restart only after a later deployment approval

No firewall, VPN, NAT, source allowlist, port, bind, or Suricata rule change is proposed.

## Verification

- Unit tests for key decoding and rotation, signature, exact-body integrity, duplicate JSON/security headers, stale/future timestamps, clock rollback, persistent replay across restart, same-digest idempotence, mismatched-digest rejection, malformed nonce, wrong/missing/weak key, body/schema bounds, source enforcement, redirect/proxy refusal, authenticated request-bound acknowledgement validation, spool atomicity/permissions/locking/quarantine/retries/ordering/overflow, and the exact fail-closed state machine.
- Receiver tests for bounded concurrency, header/body/read limits, authentication and accepted-event rate limits, constant-size auth errors, asynchronous advisory generation, JSONL `flush`/`fsync`, SQLite commit, partial-write reconciliation, and unique event IDs.
- Integration test with both services on isolated loopback test ports and generated test-only keys.
- Loopback-only integration tests prove forwarding/proxy headers cannot replace the injected test socket peer. Do not bind, connect, or send test traffic to `10.50.0.100`; defer actual source-address verification to a separately approved deployment test. Assert production listener and bind defaults remain unchanged in source configuration.
- Default-off local denial produces a gateway JSONL event and one authenticated acknowledged receiver record with matching correlation tags.
- Receiver outage causes request-intake mutation to fail closed and creates only a redacted bounded spool record.
- Restored receiver drains telemetry once without duplication and never replays the blocked mutation.
- Existing gateway and IDS suites remain green.
- Independent Roadex security and Intrusion Detection review before deployment.

## Rollback

1. Keep request intake false.
2. Disable the forwarding feature flag and stop the drainer without deleting or replaying evidence.
3. Restore prior gateway and receiver build artifacts and schema-compatible database state separately; retain migration backups and reconciliation records.
4. Retain current and previous key IDs needed to authenticate stored evidence during rollback.
5. Restart only the changed service after restoring its artifact.
6. Verify existing gateway access and IDS OPNsense/syslog ingestion remain available.
7. Keep request intake false until authenticated forwarding is deployed and revalidated. Delete no incident evidence without owner approval.

## Approval Requested

Approve source and test-code implementation plus unit and loopback-only integration testing with generated ephemeral keys for authenticated redacted bridge-event forwarding between the gateway and IDS receiver. This does not authorize binding or traffic on `10.50.0.100`, production/local secret-file changes, deployment, service restarts, live listeners, intake enablement, MSI testing, network-policy or Suricata changes, Roadex mutations, additional bridge routes, hardware access, or firmware operations.
