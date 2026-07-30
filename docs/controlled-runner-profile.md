# Controlled Runner Capability Profile

Roadex defaults every Codex process to `workspace-write` with network access
denied. The optional `controlled-project-manager` mode keeps those constraints
and exposes only preapproved A-Team, Skiller, and bounded Overseer MCP tools.

## Security Boundary

- The mode is off unless `ROADEX_CONTROLLED_RUNNER_ENABLED` is literal `true`.
- The authenticated Roadex user and workspace must either match the static
  compatibility allowlist or an active server-owned grant created by the
  completed project-creation state machine.
- Roadex accepts only the fixed profile definition
  `roadex-controlled-project-manager`.
- Codex starts with `--ignore-user-config`, then receives the complete profile
  through fixed, source-controlled `--config` arguments. This prevents
  unrelated user-global MCP servers from entering the controlled session and
  avoids mutable profile-file drift.
- Shell network access remains denied and no parent workspace is writable.
- Overseer access uses a source-controlled stdio adapter. It exposes only
  service status, redacted remote-testing status, and bounded crew-message
  creation through fixed CLI commands and fixed local paths. It cannot execute
  admin changes, dispatch work, accept a token, or make arbitrary API calls.
- Capability selection is reevaluated for every prompt; malformed allowlist
  entries are ignored and durable grants must exactly match the authenticated
  user, workspace ID, canonical workspace root, managed thread ID, and Codex
  thread ID.

The project-creation broker creates no runner grant at proposal, confirmation,
lease, repository creation, push, or thread-start checkpoints. The verified
workspace and managed-thread evidence is persisted at `thread-started`; the
grant is inserted atomically with the final `completed` transition. Failed,
pending, mismatched, neighboring, and revoked records remain restricted.
Grants are stored in the server-side project-creation SQLite database, are not
part of browser DTOs, survive Roadex restarts, and can be revoked internally.
Current managed-project authorization is still checked before every prompt.

## Deployment

The controlled profile is deployed through the user-service drop-in
`~/.config/systemd/user/roadex.service.d/controlled-runner.conf`.

The current static compatibility allowlist is restricted to authenticated user
`owner` and the explicit AI Project Manager and DonutHole workspace IDs.
Projects completed after automatic enrollment is deployed do not require a
workspace-specific systemd edit or restart. Roadex-managed smoke tests verify
that approved workspaces can call A-Team, Skiller, and the bounded Overseer
status adapter without interactive approval cancellation.

Revoking a durable grant, removing a static user/workspace entry, or setting the
global gate to any value other than literal `true` takes effect on the next
prompt.

The controlled verification and publishing foundation is documented in
[`controlled-operations-design.md`](controlled-operations-design.md). Its MCP
configuration is omitted unless a valid opaque operation token is supplied.
The bearer value is never placed in Codex process arguments: Roadex creates a
mode-restricted one-time runtime file and the MCP adapter opens it without
following symlinks, validates it, and unlinks it after reading. The live Roadex
service issues such tokens only for an exact authorized directive, user,
session, workspace, and repository binding. The dedicated host broker is
separately gated and consumes each signed operation grant once.

Rollback: remove the controlled-runner systemd drop-in, run
`systemctl --user daemon-reload`, and restart `roadex.service`. This restores
the restricted runner for every workspace.
