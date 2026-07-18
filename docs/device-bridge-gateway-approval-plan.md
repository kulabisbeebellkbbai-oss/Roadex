# Device Bridge Gateway Approval Plan

Status: revised staged proposal for code and local tests only. Do not deploy, restart, or enable without a later explicit approval.

## Current State

Read-only inspection on 2026-07-18 confirmed:

- `roadex.service` is active on `127.0.0.1:8780` at Roadex commit `c4e751f9d14f4aac1c10540a6f211bddac28454c`.
- `protected-service-gateway.service` is active with TLS only on `10.50.0.100:9443` at gateway commit `ba2a38458bbed7fc47edbc49b6a447b139ce6a41`.
- The host also has `192.168.68.100`; the gateway must never bind there, on `0.0.0.0`, or on IPv6.
- Exact gateway route and method checks reject all device-bridge paths.
- Roadex has no device-bridge HTTP handlers. Its policy is disabled, capability detection is passive, and its state machine is test-only with mandatory injected resolvers.
- No browser chooser, USB handle, artifact-byte delivery, or firmware write is enabled.

This work changes no firewall, VPN source, NAT, port, listener, or service identity. Existing approved VPN-client restrictions remain unchanged.

## Proposed External Slice

Add only this authenticated, control-plane route:

| Method | Exact external gateway path | Maximum JSON body | Purpose |
| --- | --- | --- | --- |
| `POST` | `/Roadex/api/sessions/:sessionId/device-bridge/requests` | 8 KiB | Create an owner-scoped request from immutable artifact metadata when request intake is separately enabled. |

Keep every other bridge route gateway-blocked, including approval issuance, capability, approval start, artifact retrieval, probe, authorize-write, events, and cancellation. Local tests may exercise their internal denial behavior.

Use separate policy states:

- `deviceBridgeRequestIntakeEnabled`: permits only pending request creation when true.
- `deviceBridgeOperationsEnabled`: permits approval or operation behavior when true; it remains hard-disabled in this slice.

Both flags default false. Local tests inject the intake flag explicitly. This approval does not authorize changing either deployed flag.

## Exact Gateway Controls

- Add a bridge-specific dispatcher before generic route selection and honeypot handling. Bridge requests cannot route through Referer or `session.current_service`; they require the literal `/Roadex` prefix.
- Validate the raw request target before `urlparse()`. Accept one anchored ASCII expression with the session identifier restricted to `[A-Za-z0-9_-]`, length 16 through 128.
- Reject absolute-form targets, percent escapes, literal `?` or `#`, empty identifiers, dot segments, duplicate slashes, backslashes, semicolons, trailing slashes, extra segments, and non-ASCII input.
- Permit only the exact method/path pairs above. All other methods and bridge paths receive a uniform non-success rejection and a structured audit event; they must not be proxied or disguised as honeypot success.
- Require exactly one `Origin` equal to `https://10.50.0.100:9443` and exactly one `X-Roadex-CSRF` header before reading or parsing a body and before ordinary rate-limit accounting.
- Generate a 256-bit CSRF token with the operating-system CSPRNG, store only its SHA-256 digest server-side, bind it to gateway session and principal, and compare digests in constant time. On a successful authenticated `GET /Roadex/api/bootstrap`, the gateway adds the raw token as a single `X-Roadex-CSRF` response header without rewriting the Roadex JSON body. The client reads it into page memory only. Roadex never owns or receives the raw token. Missing token state causes the gateway to omit the header and reject all bridge mutations. Never put the token in browser persistence, a cookie, URL, log, or backend error. Rotate it at login/session renewal and invalidate it at logout/termination.
- Reject missing, duplicate, comma-combined, `null`, opaque, or mismatched Origin/token values. SameSite cookies remain defense in depth.
- Require one valid non-negative `Content-Length`; reject duplicate/conflicting values, `Transfer-Encoding`, and `Expect`. Close the connection after early rejection unless the bounded body is safely drained. Accept `Content-Type: application/json` only.
- Parse strict UTF-8 JSON with an object at the top level, duplicate-key detection, no non-finite numbers or trailing data, and a maximum nesting depth of 4. Reject unknown fields. Bound identifiers to 128 ASCII characters, display labels to 128 Unicode scalar values after normalization, arrays to 16 entries, and the complete body to 8 KiB.
- Keep stripping all client-supplied `X-Roadex-*` headers before injecting gateway-owned identity.
- Reject the bridge request if the gateway shared secret or authoritative identity is unavailable. Do not trust `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, or any client identity header.
- Remove hard-coded `security-reviewer` injection for bridge requests. Resolve the minimum required `user` role from the authoritative authorization record and fail closed if unavailable.
- Apply `Cache-Control: no-store` to every bridge response and error.
- Add CSP `frame-ancestors 'none'` and preserve a same-origin-only script/connect policy without `unsafe-inline` or `unsafe-eval`. Do not grant USB or serial Permissions-Policy yet.

## Limits And Concurrency

Use bridge-specific bounded stores and independent fixed-window buckets:

- Request creation: sliding-window limits of 10 per minute per gateway session, 20 per minute per principal, and 20 per minute per VPN client/source.
- Origin/CSRF abuse: independent counter; alert at 3 failures per minute per source and terminate the gateway session at 10 failures per minute.
- At most 3 pending requests per session and 5 per principal. Approval cannot create an operation while production policy is disabled.
- Bound each limiter to 1,024 keys, prune expired entries on each check, remove session keys at termination, and fail closed with `429`, `Retry-After`, and `no-store` when full.
- Evaluate and consume all session/principal/source buckets atomically under one lock so a rejected dimension consumes none of the ordinary buckets. Use monotonic time, fail closed after process restart until stores initialize, and test clock boundaries, concurrent requests, capacity exhaustion, cleanup, and source churn.

These values are initial security limits and must be covered by boundary, expiry, key-isolation, cleanup, and concurrency tests.

## Roadex Authorization

- Authenticate through gateway-injected identity and the shared-secret boundary.
- Validate current user, ownership, session lifecycle, workspace binding, immutable artifact record/digest, inventory record, expiry, and the request-intake policy before pending-request mutation. The operation policy remains false and independently blocks every later transition.
- This slice creates a pending request only. It cannot issue an approval or start an operation.
- Reject cross-owner, cross-session, cross-workspace, stale, replayed, malformed, unknown, or policy-disabled transitions without leaking object existence.
- Persist only projected typed records; discard unknown credential, token, firmware, probe, and arbitrary text fields.

## Logging And Alerts

Gateway and Roadex events conform to a strict schema with bounded action/outcome/reason enums, HTTP status, HMAC-pseudonymized source/VPN/principal/object identifiers, keyed correlation ID, policy version, latency bucket, and bounded body-size metadata. Use a dedicated audit HMAC key stored separately from gateway and CSRF secrets.

Normalize every session, request, approval, operation, artifact, nonce, and challenge identifier. Never record raw URLs/query strings, bodies, cookies, authorization or CSRF headers, credentials, nonce/challenge values, raw device identity, USB strings, storage references, firmware, or backend/client error text.

Create logs with owner-only mode `0600`, reject symlinks, rotate them by bounded size, and retain them no longer than existing Roadex security retention. A request mutation succeeds only after its required audit event is durably appended; audit open/write/fsync, disk-full, rotation, or acknowledged-forwarding failures fail closed. Alert through the authenticated Intrusion Detection receiver with acknowledgement on:

- immediate: any blocked approval/start/probe/authorize-write/event/cancel/artifact request, identity mismatch, audit failure, unexpected policy enablement, source/bind/port drift, or TLS-disabled start;
- 3 Origin/CSRF failures from one source in one minute;
- aggregated by source and reason: encoded delimiter, malformed bridge path, unsupported method/content type, oversized body, and limiter events;
- any replay, expired credential, cross-owner/session/workspace denial, or identity/digest mismatch;
- any limiter or pending-request concurrency rejection;
- backend error/timeout, audit-write or forwarding failure, or missing expected audit heartbeat;
- any unexpected source/VPN identity, listener/port drift, or TLS-disabled gateway start.

Gateway/Roadex structured events are authoritative because Suricata cannot inspect these HTTPS paths. Do not enable the staged Suricata HTTP or pass signatures for this slice. Alert delivery and receiver acknowledgement must be tested end to end before MSI smoke testing.

## Code And Local Verification

- Gateway tests for both allowed pairs and all route, method, encoding, Origin, CSRF, content framing, schema, body-limit, identity-header, rate, and redaction failures above.
- Roadex tests for authentication, ownership, workspace, policy, artifact, inventory, expiry, replay, persistence projection, and fail-closed audit behavior.
- Local integration smoke with policy disabled: pending request records behave as specified, approval and operation creation remain impossible, blocked routes never reach Roadex, and existing session state remains unchanged.
- Run `npm test`, `npm run lint`, and `npm run build` in Roadex; run `python3 -m pytest` in the gateway.
- End this phase after all local suites, integration tests, security review, and source-diff review pass. Do not install builds, restart services, or change deployed configuration.
- Before any later MSI test, correlate a packet capture with gateway logs to prove the gateway receives the assigned VPN tunnel source rather than a translated OPNsense address. MSI testing remains excluded from this approval.

## Risk And Impact

The change expands authenticated HTTP attack surface around a future destructive workflow. Risks include CSRF, path smuggling, replay, cross-session object access, audit leakage, limiter bypass, denial of service, and accidental premature operation enablement. The reduced slice cannot retrieve firmware, access hardware, or authorize writes.

## Independent IDS Advisory

The Intrusion Detection project reviewed this package read-only on 2026-07-18. Its first review required reducing the external surface, adding session-bound CSRF, exact raw-target/framing controls, independent limits, redacted structured logs, authoritative gateway/Roadex alerts, bind preservation, and targeted rollback. Its second review required the final one-route scope, literal `/Roadex` prefix, bridge-specific pre-router, fail-closed identity injection, severity-tiered alerts, source-translation proof before MSI testing, and release-level rollback.

The advisory explicitly requires no firewall, IDS, bind, VPN, NAT, source, listener, or service change for this slice. It confirms Suricata cannot inspect the protected HTTPS paths and that authenticated gateway/Roadex events must be authoritative. No custom firewall or Suricata rule is required for code/local-test staging; deployment still requires tested alert forwarding and a separate approval package.

## Later Deployment Rollback Requirements

These requirements apply to a later deployment approval, not this code/local-test approval:

1. Disable the bridge request-intake feature flag and revoke/delete pending request records using the schema-compatible cleanup command prepared with the release.
2. Restore the versioned previous gateway build artifact and configuration snapshot; restart only `protected-service-gateway.service`; verify every bridge path is rejected. Do not reset the repository.
3. Restore the versioned previous Roadex build artifact and configuration snapshot; run the tested backward-compatible request-store migration if needed; restart only `roadex.service`. Do not reset the repository.
4. Verify existing Roadex and other gateway services remain available; verify TLS, approved sources, audit forwarding, no active bridge state, and listeners `127.0.0.1:8780` plus `10.50.0.100:9443` only.
5. Before any deployment approval, record exact artifact checksums, config backup paths, feature-flag locations, migration/cleanup commands, restart commands, and health checks. Stop both services only for an active exposure or authorization incident.

## Approval Requested

Approve source-code implementation and local automated/integration testing of the one exact request-creation route, separate default-off intake/operation flags, gateway-owned session-bound CSRF protection, strict framing/schema validation, fail-closed identity injection, bounded request storage and rate limiting, CSP framing protection, and redacted structured audit events described above.

This approval does not authorize installing either build into a running service, restarting services, changing deployed flags/configuration, making the route remotely reachable, sending production alerts, approval issuance, capability exposure, browser chooser calls, USB/serial Permissions-Policy grants, operation start/probe/write/event/cancel routes, artifact delivery, hardware access, firmware writing, MSI testing, firewall/IDS/VPN/NAT/source changes, or new ports/listeners. A later deployment package must include exact build artifacts/checksums, backups, commands, alert tests, source-translation proof, and rollback commands for separate approval.
