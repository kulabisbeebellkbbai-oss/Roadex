# IDS/Security Advisory: Route-Scoped Project Admin Forwarding

Review the current uncommitted Protected Service Gateway diff in:

`/home/god/Documents/Codex Workspace/Protected Service Gateway`

Approved objective:

- Permit the exact Roadex project-creation routes to reach Roadex with roles
  `user,admin,security-reviewer` only for a principal already accepted by
  `ROADEX_GATEWAY_PROJECT_CREATION_OWNER_PRINCIPALS`.
- Keep normal Roadex proxying, device-bridge intake, device-bridge management,
  unauthorized principals, malformed routes, and missing owner configuration
  at `user,security-reviewer` or denied.

Review questions:

1. Does the forwarding helper independently require a parsed `project_*` kind
   and exact owner allowlist membership before adding `admin`?
2. Can any non-project, malformed, disabled, or unauthorized request reach
   Roadex with `admin`?
3. Is authorization performed before body inspection, IDS forwarding, quota
   consumption, idempotency reservation, and backend dispatch?
4. Do existing redacted audit and IDS event contracts remain unchanged?
5. Are the focused leakage tests and full gateway/Roadex suites sufficient for
   deployment of this narrow role fix?
6. Does this require any firewall, Suricata, IDS schema, or receiver restart?

Current local evidence:

- Focused gateway bridge suite: 89 passed.
- Full gateway suite: 232 passed.
- Roadex suite: 217 passed.
- Roadex lint and production build passed.
- No project proposal, directory, GitHub repository, or Codex registry entry
  exists for DonutHole.

The first advisory identified two blockers. Both are now addressed:

- Admin forwarding uses an exact allowlist of the five parsed project route
  kinds rather than a prefix test, with a negative `project_unknown` test.
- Handler-level denial tests prove disabled, unauthorized, missing-owner, and
  malformed requests do not read the body, consume quota, reserve idempotency,
  emit an authorized IDS event, or open a backend connection.

Report blockers first. This is a read-only advisory; do not edit files or
restart services.
