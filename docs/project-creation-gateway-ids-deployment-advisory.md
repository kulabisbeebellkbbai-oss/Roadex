# IDS Advisory Request: Roadex Project Creation Gateway Deployment

Review the explicitly approved deployment of the existing protected Roadex
project-creation route contract.

## Current State

- Protected Service Gateway listens on `10.50.0.100:9443` with the existing
  `roadex.home.arpa` TLS identity and approved VPN/firewall policy.
- Roadex remains bound to `127.0.0.1:8780`.
- Gateway project-creation flags are absent and therefore default off.
- IDS forwarding, authenticated acknowledgement, durable spool handling, and
  the IDS receiver are already enabled.
- The IDS receiver source recognizes only the five normalized project routes
  and their exact methods.
- Roadex-local project request, confirmation, execution, controlled bootstrap,
  and registrar gates are deployed for owner `owner`.

## Proposed Deployment

Enable only:

- `ROADEX_GATEWAY_PROJECT_CREATION_REQUEST_ENABLED=true`
- `ROADEX_GATEWAY_PROJECT_CREATION_CONFIRM_ENABLED=true`
- `ROADEX_GATEWAY_PROJECT_CREATION_STATUS_ENABLED=true`
- `ROADEX_GATEWAY_PROJECT_CREATION_REVOKE_ENABLED=true`
- `ROADEX_GATEWAY_PROJECT_CREATION_OWNER_PRINCIPALS=owner`

Then rebuild/restart Protected Service Gateway and restart Intrusion Detection
only if its deployed receiver is older than the reviewed route schema.

## Intended Traffic

- Source: authenticated existing VPN/browser clients allowed by current
  gateway/firewall policy.
- Destination: `10.50.0.100:9443`.
- Service: existing Protected Service Gateway.
- Routes: exact Roadex project proposal, status, challenge, confirmation, and
  revocation routes.
- Identity: exact owner principal only.
- Controls: existing Origin, CSRF, rate limiting, strict schema/projection,
  durable idempotency, IDS forwarding, audit pseudonymization, and no-store
  responses.

## Test Boundary

Run authenticated route-level tests that verify route availability, non-owner
denial, malformed and old-schema denial, Origin/CSRF enforcement, IDS receipt,
rate behavior, and redacted logs. Do not submit a valid project proposal or
confirmation, launch Codex, create a sibling directory, mutate the live Codex
registry, or call GitHub.

## Requested Advisory

Confirm:

1. Existing VPN-only bind and firewall policy remain sufficient.
2. Existing IDS forwarding/receiver schemas cover the enabled routes.
3. No custom firewall or Suricata rule is required for this route-only change.
4. Logging, alerting, rollback, and route-level test controls are sufficient.
5. Any blocker before applying the already-approved gateway/IDS deployment.

Rollback removes the five gateway variables, restores owner-only backups,
restarts the gateway through Overseer, and verifies all project routes return
their disabled response while Roadex remains healthy.
