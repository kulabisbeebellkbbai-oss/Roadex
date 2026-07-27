# Project Creation Worker Deployment

Status: Roadex-local worker, protected gateway/IDS route deployment, and
authenticated non-mutating MSI route smoke complete. Live project creation
remains a separate boundary.

## Deployed Scope

- Built the AI Project Manager fixed project-creation adapter.
- Built Roadex with the durable worker and controlled thread finalizer.
- Enabled the Roadex-local request, confirmation, execution, controlled
  bootstrap, and non-launching registrar gates for authenticated owner `owner`.
- Bound proposals to the managed AI Project Manager source workspace.
- Configured the fixed Codex workspace parent and GitHub owner.
- Generated independent project-audit, registrar-binding, and registrar-audit
  HMAC keys in ignored mode-600 local configuration.
- Restarted only `roadex.service` through approved Overseer plan
  `admin.roadex-project-creation-worker-20260725`.
- Enabled the five exact Protected Service Gateway project-creation routes
  under separate literal-true gates and owner principal `owner`.
- Restarted the gateway and IDS receiver through approved Overseer plans
  `admin.roadex-project-gateway-20260725` and
  `admin.roadex-project-ids-20260725`.

## Verification

- AI Project Manager and Roadex production builds passed before restart.
- `roadex.service` is active with no automatic restart.
- Roadex listens on `127.0.0.1:8780`.
- `GET /api/health` returned the expected healthy service response.
- The running process contains every approved literal-true gate and all three
  independent keys without logging their values.
- The post-restart journal contains no configured key, bearer token, OpenAI
  token, or private-key marker.
- The project-creation database is empty or not initialized.
- The live Codex project registry timestamp and size remain unchanged.
- Protected Service Gateway full suite passed with 216 tests.
- Intrusion Detection full suite passed with 40 tests using `PYTHONPATH=src`.
- Gateway, IDS, and Roadex services are active on their intended listeners.
- Gateway `/health` and `/healthz`, IDS `/health`, and Roadex `/api/health`
  returned healthy responses.
- The unauthenticated exact proposal route returned the protected gateway HTML
  surface with `Cache-Control: no-store`; it did not reach Roadex or create
  project state.
- The authenticated MSI negative-schema smoke reached the exact proposal route
  from the approved VPN source and received a JSON `403` response with
  `Cache-Control: no-store`.
- Gateway audit recorded `bridge_management_request_rejected` with
  `csrf_invalid`; IDS durably stored the matching normalized event as
  `invalid_csrf` with status `403`.
- Gateway and IDS used matching pseudonymized source, account, and VPN-client
  hashes. No raw browser credential or request body was logged.
- Roadex has no persisted project-creation top-level state, no project-creation
  database exists, and the Codex project registry remains unchanged.

## Backup And Rollback

Owner-only backup:

`local-secrets/backups/project-creation-20260725T163934Z`

Gateway owner-only backup:

`../Protected Service Gateway/local-secrets/backups/project-creation-gateway-20260725T165105Z`

IDS owner-only backup:

`../Intrusion Detection/local-secrets/backups/project-creation-ids-20260725T165105Z`

Rollback:

1. Restore `roadex-gateway.env`, `roadex.service`, and
   `controlled-runner.conf` from the backup.
2. Rebuild Roadex if source rollback is also required.
3. Run `systemctl --user daemon-reload`.
4. Restart `roadex.service` through an approved Overseer admin plan.
5. Verify `/api/health`, localhost-only binding, absent project-creation gates,
   empty operation state, and unchanged live Codex registry.

## Remaining Boundary

This deployment does not create a sibling directory, launch a controlled
bootstrap, mutate the live Codex registry, call GitHub, or run the live
end-to-end project-creation smoke. Live project creation requires a separate
explicit approval with the exact project name and visibility.
