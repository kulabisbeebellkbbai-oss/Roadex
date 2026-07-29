# DonutHole Controlled Runner Deployment

Date: 2026-07-27

## Scope

The approved Roadex controlled runner now includes the exact DonutHole
workspace alongside the existing AI Project Manager workspace. The authorized
user allowlist remains unchanged.

The fixed capability profile provides:

- the approved A-Team tool subset;
- the approved Skiller tool subset;
- the Roadex-owned Overseer stdio adapter with only `service_status`,
  `remote_testing_status`, and `record_crew_message`.

Shell network access remains disabled. The Overseer adapter accepts no command,
path, token, API endpoint, admin action, dispatch operation, or arbitrary
network request.

## Deployment

- Overseer plan:
  `admin.roadex-donuthole-controlled-runner-20260727`
- Execution:
  `admin.exec.admin.roadex-donuthole-controlled-runner-20260727.completed`
- Result: completed and service active
- Health: Roadex API returned `ok`
- Rollback copy:
  `local-secrets/backups/controlled-runner-20260727/controlled-runner.conf`

The rollback copy is local-only and must not be committed.

## Verification

- Controlled runner and adapter contract tests passed.
- Full Vitest suite passed with 225 tests.
- Pixel 7 Chromium and iPhone 15 WebKit suites passed with six tests.
- Production build and focused ESLint checks passed.
- Production dependency audit reported zero vulnerabilities.
- MCP stdio smoke listed exactly the three approved Overseer tools and returned
  service status without mutation.
- The existing DonutHole managed thread completed a bounded smoke in which
  A-Team `list_teams`, Skiller `recommend_skills`, and Overseer
  `service_status` each succeeded.
