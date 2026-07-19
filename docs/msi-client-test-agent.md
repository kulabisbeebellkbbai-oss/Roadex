# MSI Client Test Agent

Roadex uses the MSI agent as the standard executor for client-side testing. A trusted browser interpreter installed separately on MSI runs versioned declarative suites shipped in `client-tests/`. Queue jobs select a suite; neither jobs nor suites carry executable code or shell commands.

The machine-readable contracts are `client-tests/job.schema.json`, `client-tests/manifest.schema.json`, `client-tests/suite.schema.json`, and `client-tests/result.schema.json`.

## Agent Contract

The MSI agent accepts `roadex.client_suite` jobs with this bounded shape:

```json
{
  "id": "job identifier",
  "type": "roadex.client_suite",
  "commit": "full Roadex commit SHA",
  "suite": "suite ID from client-tests/suites.json",
  "headed": true,
  "configuredProject": "optional project display name",
  "unconfiguredProject": "optional project display name",
  "destructiveApproval": false
}
```

The agent must fetch the requested commit as data from the configured Roadex repository, require it to be reachable from the approved branch, validate the job with its trusted local copy of `job.schema.json`, and validate the selected manifest and suite against trusted local schema copies. The MSI agent owns its browser automation dependency and interpreter outside the tested checkout. It must not install dependencies or execute code, package scripts, reporters, commands, or arguments from the Roadex checkout.

Only the closed actions in `suite.schema.json` are supported. They cover navigation, visible-control assertions, clicks, option selection, enabled-state assertions, fixed-slot attribute comparisons, and browser-error checks. Suite data cannot supply regular expressions or executable selectors. Extend the trusted interpreter deliberately when a genuinely new browser behavior is needed; ordinary Roadex tests are added as declarative cases without changing the queue allowlist.

The trusted agent resolves every navigation against the fixed `https://roadex.home.arpa:9443` origin, then verifies the resolved origin is unchanged and the path begins with `/Roadex` before loading it. Network-path references, encoded separators, credentials, fragments, and unexpected query strings are rejected.

The agent owns a sensitive-control classification independent of suite data. At minimum `create-probe-approval`, `run-controlled-probe`, `confirm-verified-target`, `verify-firmware-bytes`, and `flash-firmware` are sensitive. A `click` targeting any sensitive control is rejected unless the trusted classification permits the phase, the selected suite is marked destructive, and the fresh job has `destructiveApproval: true`. Roadex owner approval and server authorization remain mandatory.

Use a dedicated unprivileged Windows account and dedicated Chrome profile or browser storage-state file held only on MSI. Before every run, the trusted agent verifies that authentication files are regular local files owned by that account and not writable by other principals. The user signs in through the protected gateway when that profile is unauthenticated. The agent must not copy authentication state into the queue, logs, archives, screenshots, or result JSON.

The trusted agent creates results itself and binds each result to the submitted job ID, exact commit, and suite. It reduces output to complete aggregate counters, manifest-declared case ID, test status, and failure class. It rejects undeclared case IDs and verifies that counters equal the case results and agree with overall status before publishing. Do not return browser-library titles, error messages, DOM snapshots, URLs containing query data, headers, cookies, CSRF values, credentials, transcript text, project roots, thread/session identifiers, device identities, serial numbers, MACs, HMACs, or request/response bodies.

## Hardware And Manual Steps

Suites may exercise Roadex WebUSB, Web Serial, and Web Bluetooth controls through trusted click and manual-checkpoint actions. Browser chooser selection, permission prompts, physical reset, connection, and other user-gesture requirements are reported as `needsUser` with only the viewport, manifest-declared case and checkpoint IDs, and bounded prompt code. Checkpoint IDs must be unique within a case. After the user completes the checkpoint, the same job, viewport, and case resume from that checkpoint. Terminal results cannot carry checkpoints. Read-only peripheral tests do not require a new queue allowlist entry.

Firmware transfer, writes, flashing, erase, operation creation, and other destructive actions require both a suite marked `destructive: true` and a fresh job with `destructiveApproval: true`. Existing Roadex owner approval, verified inventory binding, and server authorization remain required; the agent flag cannot bypass them.

## MSI Environment

The agent supplies these variables without including their values in results:

- `ROADEX_E2E_BASE_URL`
- `ROADEX_E2E_APP_PATH`
- `ROADEX_E2E_STORAGE_STATE`
- `ROADEX_E2E_OUTPUT_DIR`
- `ROADEX_E2E_HEADED`
- `ROADEX_E2E_CONFIGURED_PROJECT`
- `ROADEX_E2E_UNCONFIGURED_PROJECT`

The protected MSI run must not set `ROADEX_E2E_REQUIRE_NO_STORE=0`; that override exists only for isolated loopback development checks that do not traverse the gateway.

Browser traces, videos, screenshots, DOM snapshots, and raw failure messages are disabled by default. The trusted agent deletes stale artifacts before each run and cleans temporary browser artifacts in an unconditional finalizer after success, failure, cancellation, or timeout. Diagnostic retention may be enabled only when the user explicitly approves it for a specific run; retained files remain local and are not returned through the queue.

Stop the MSI agent to disable remote test execution. Roll back a v7 installation by restoring the currently verified `roadex-msi-test-agent-v6`; no gateway, firewall, or Roadex service change is required.

## Version 7 Execution Contract

The trusted MSI interpreter must treat each declared viewport as an independent execution unit. For every viewport it must create a fresh browser context from the same ACL-checked MSI-local storage-state file, apply a new bounded timeout budget, execute the declared cases, close all pages and the context in a `finally` block, and wait for live Roadex stream requests to close before starting the next viewport. Page state, local-storage mutations, console buffers, assertion slots, and timeout consumption must not carry between viewport units.

The queue worker must claim an already-pending `roadex.client_suite` job immediately after a successful `roadex.client_auth_setup` action. It must not return to the ordinary polling delay between those jobs. If no suite is pending, the auth browser must keep the protected-gateway heartbeat active until the auth action completes; a later suite must detect expired gateway state as `needsUser` before running assertions.

The runner must preserve these boundaries:

- Authentication storage remains under the dedicated MSI account and never enters queue jobs, results, logs, archives, or the Roadex checkout.
- Repository suites remain declarative data and cannot supply code, shell commands, selectors outside declared test IDs, timeout values, or cleanup behavior.
- Viewport cleanup must not call Roadex termination, archive, close, approval, operation, firmware, USB-write, or flash endpoints.
- Result aggregation occurs only after each viewport has produced a terminal result. Output remains limited to the existing result schema.
- Expected context cleanup may close SSE connections, but genuine HTTP failures and browser errors remain test failures.

Acceptance requires:

1. Run `roadex.client_auth_setup` with a suite already pending and confirm the suite starts before protected-gateway heartbeat expiry.
2. Run `portal-smoke` across desktop, tablet, and mobile in one job and require every declared case to pass.
3. Run `project-device-controls` across desktop, tablet, and mobile in one job and require `device.project-control-boundaries` to pass in every viewport.
4. Confirm gateway evidence contains allowed Roadex requests and normal client-closed stream cleanup without heartbeat diversion or subscriber-limit denial.
5. Confirm no device chooser, firmware transfer, write, approval, or operation action occurred.
