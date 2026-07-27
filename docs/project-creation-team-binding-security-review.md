# Security Review: Project Creation Team Binding

Review the current uncommitted Roadex diff in:

`/home/god/Documents/Codex Workspace/Roadex`

Context:

- Protected Service Gateway successfully forwarded an authenticated,
  route-scoped-admin DonutHole proposal.
- Roadex denied it because the broker assumed `team.title === projectName`.
- The explicitly approved A-Team is `QZgKChq89x56`, titled
  `Royal Court of Princess Donut`, for project `DonutHole`.

Proposed correction:

- Replace team-title equality with a server-owned JSON environment binding list:
  `ROADEX_PROJECT_CREATION_APPROVED_TEAM_BINDINGS`.
- Encode it as an array of `[projectName, teamId]` pairs so duplicate project
  bindings can be rejected after structured parsing.
- Require an exact project-name key and exact submitted team ID value.
- Fail closed for missing, empty, malformed, oversized, non-object, excessive,
  invalid-name, invalid-ID, or mismatched bindings.
- Continue resolving the live A-Team record and requiring exact team ID,
  approved status, and no draft assignments.
- Continue snapshotting the complete live team digest and revalidating it at
  challenge, confirmation, and execution.

Review for authorization bypass, project/team substitution, case handling,
duplicate JSON keys, prototype/object hazards, revocation and drift, secret
exposure, persistence effects, and missing tests.

Evidence:

- Focused broker suite: 12 passed.
- Full Roadex suite: 218 passed.
- Lint and production build passed.
- Failed proposal created no proposal, operation, or project audit row.
- No DonutHole directory, GitHub repository, registry entry, or initial thread
  was created.

Read-only. Report blockers first. No deployment or service restart is part of
this review.
