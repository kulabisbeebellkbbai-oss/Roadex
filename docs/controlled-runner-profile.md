# Controlled Runner Capability Profile

Roadex defaults every Codex process to `workspace-write` with network access
denied. The optional `controlled-project-manager` mode keeps those constraints
and exposes only preapproved A-Team and Skiller MCP tools.

## Security Boundary

- The mode is off unless `ROADEX_CONTROLLED_RUNNER_ENABLED` is literal `true`.
- Both the authenticated Roadex user and workspace ID must be explicitly
  allowlisted.
- Roadex accepts only the fixed profile definition
  `roadex-controlled-project-manager`.
- Codex starts with `--ignore-user-config`, then receives the complete profile
  through fixed, source-controlled `--config` arguments. This prevents
  unrelated user-global MCP servers from entering the controlled session and
  avoids mutable profile-file drift.
- Shell network access remains denied and no parent workspace is writable.
- Capability selection is reevaluated for every prompt; malformed allowlist
  entries are ignored.

This profile does not itself grant project creation. A future project-creation
broker must require a one-time Roadex grant bound to the authenticated user,
session, approved summary, approved A-Team plan, validated project name,
explicit repository visibility, and expiry. Until that broker and grant flow
are separately approved, sibling project creation remains unavailable.

## Deployment

The controlled profile is deployed through the user-service drop-in
`~/.config/systemd/user/roadex.service.d/controlled-runner.conf`.

The current allowlist is restricted to authenticated user `owner` and workspace
`codex-project-ai-project-manager-cacb4e3a`. A Roadex-managed smoke verified
that this workspace can call the read-only A-Team `list_teams` and Skiller
`recommend_skills` tools without interactive approval cancellation.

Removing a user/workspace from either allowlist or setting the gate to any value
other than literal `true` takes effect on the next prompt.

Rollback: remove the controlled-runner systemd drop-in, run
`systemctl --user daemon-reload`, and restart `roadex.service`. This restores
the restricted runner for every workspace.
