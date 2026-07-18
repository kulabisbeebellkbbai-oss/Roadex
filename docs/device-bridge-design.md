# Roadex Client Device Bridge Design

## Scope

The first device-bridge slice lets an authenticated Roadex browser discover a client-connected device and offer a narrowly scoped operation to the server-side Codex session. The initial target is an ESP32 connected to an Android or desktop browser over USB.

No device operation is enabled by this document. Implementation remains behind an explicit security approval gate.

## Platform Strategy

- Chrome 89 or newer on Windows, macOS, Linux, and ChromeOS: use Web Serial for validated USB-UART devices.
- Chrome on Android: use WebUSB plus the Web Serial polyfill only when Android has not claimed the interface. Android support is experimental until the hardware matrix passes.
- iOS and browsers without the required APIs: report the capability as unavailable. Do not add a native relay or installable helper in the first slice.
- The browser owns the physical device handle. The server never receives direct USB access.
- The server creates short-lived, session-bound approvals and operation leases. The client executes only the approved operation and returns bounded status output.

Initial compatibility testing is limited to explicitly inventoried ESP32 boards using CP210x or CH34x USB-UART bridges, an Android device with USB OTG host support, a powered connection appropriate for the board, and current stable Chrome. CDC-ACM and native-USB ESP32 variants are unsupported until separately tested. The test matrix must record phone model, Android version, Chrome version, board, USB-UART chipset, cable/adapter, power arrangement, and result.

Chrome documents Web Serial on desktop and an Android fallback through WebUSB plus a serial polyfill, limited to interfaces accessible through WebUSB. See [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial) and [Chrome WebUSB platform considerations](https://developer.chrome.com/docs/capabilities/build-for-webusb).

## Trust Boundaries

- Browser UI: untrusted input and device transport endpoint.
- Protected gateway: authenticated identity and origin enforcement.
- Roadex server: policy decision point, approvals, operation leases, audit log, and session binding.
- Codex runner: may request a device operation but cannot grant one.
- Client device: untrusted hardware whose reported identity must be verified before a privileged operation.

## Consent And Operation Flow

1. The user opens Device access for the selected Roadex session.
2. Roadex checks browser capability without requesting a device.
3. A user gesture opens the browser's native device chooser.
4. The browser reports a sanitized device descriptor to Roadex. It must not include arbitrary USB strings in logs.
5. Roadex shows the requested operation, target identity, firmware artifact digest, and session/project binding.
6. The user explicitly approves one operation.
7. The server issues a short-lived approval bound to user, Roadex session, project, expected inventory identity, operation, artifact digest, and expiry.
8. The browser atomically exchanges the approval at the start endpoint. The server consumes it and creates one probe-phase operation instance. This phase authorizes only immutable artifact retrieval, bounded ESP32 bootloader synchronization/read commands, and sequenced status events. It does not authorize erase or flash writes.
9. The browser downloads the artifact, enforces its size limit, and verifies its SHA-256 digest.
10. The browser opens the selected device and runs the fixed identity-probe command sequence. It submits normalized chip family, model, revision, flash characteristics, and eFuse/base MAC results to the pre-write endpoint.
11. The server validates the submitted probe and digest without entering the destructive phase. On an exact match it returns a short-lived confirmation challenge containing display-safe actual identity, expected identity match state, verified artifact label/digest, and destructive non-cancellable warning. On any mismatch it consumes the probe phase, closes the operation, and never offers confirmation.
12. Roadex displays the confirmation challenge and requires a fresh user gesture. It cannot auto-submit, reuse the earlier approval gesture, or confirm from Codex output.
13. The browser submits the challenge at `authorize-write`. The server atomically rechecks user, session, workspace, artifact, actual identity, Origin, probe lease, challenge expiry, and revocation state before transitioning to a short destructive-phase lease.
14. The browser rechecks the destructive-phase response and begins erase immediately. It performs the operation locally, reports bounded progress, and closes the device handle in a `finally` path.
15. The server records completion, failure, cancellation, lease expiry, mismatch, and replay attempts during a separate terminal-reporting grace period that cannot authorize additional device writes.

There is no persistent "always allow" option in the first slice.

Browser device permission may persist independently of Roadex. A device returned by `getDevices()` or `getPorts()` still requires a fresh Roadex operation request, approval, and atomic start. Roadex closes all handles after each attempt and never treats browser-retained permission as application consent.

## Initial Operation Contract

The first allowed operation is `esp32.flash`. It requires:

- an active, owned Roadex session;
- an approved project workspace;
- a server-produced firmware artifact referenced by opaque identifier;
- a SHA-256 artifact digest fixed before approval;
- a verified ESP32 chip identity;
- a browser-selected USB device matching an explicit VID/PID allowlist;
- a single-use server approval consumed into one operation lease;
- a fresh user confirmation immediately before flashing.

The server stores an immutable artifact record containing project, producing session/run, filename-safe display label, content length, media type, SHA-256 digest, creation time, and storage reference. Only server-produced binary firmware formats on an operation-specific allowlist are accepted. Artifact size is bounded by policy and bytes are never supplied in a bridge request.

Arbitrary serial reads, writes, terminal bridging, filesystem access, USB control transfers, and browser-supplied firmware bytes are out of scope.

## Device Identity

- Treat USB VID/PID and product strings as hints, not sufficient identity.
- Bind approval to an expected server-owned inventory identity, then probe the ESP32 during the restricted probe phase and compare its chip family, model, revision, flash characteristics, and eFuse/base MAC before authorizing erase.
- Prefer the ESP32 eFuse/base MAC for durable identity.
- Block flashing on a mismatch or incomplete probe.
- Record only the minimum identifier needed for audit correlation; redact unnecessary serial and descriptor strings.
- The inventory record must be registered through an owner-approved workflow outside the device operation and must identify secure-boot and flash-encryption expectations.
- Identity probing is a wrong-device safety check, not cryptographic attestation. A hostile USB endpoint can spoof probe responses. Roadex must not claim that this proves device authenticity.

## Grant Requirements

Each approval must be:

- cryptographically random and stored server-side only as a digest;
- scoped to one authenticated user and one Roadex session;
- scoped to one operation, device identity, and artifact digest;
- short lived;
- atomically consumed by the start endpoint before artifact retrieval or USB write, including failed attempts;
- invalidated when the session closes, the user signs out, authorization changes, or the device selection changes;
- accepted only through protected same-origin API requests.

The resulting operation instance has a distinct random credential, stored server-side only as a digest, transported in an authorization header rather than a URL, and scoped to the consumed approval. The probe phase authorizes immutable artifact retrieval, a fixed read-oriented ESP32 bootloader probe sequence, and bounded result events. Only the atomic pre-write transition authorizes erase and flash writes. An operation cannot create another operation.

An untrusted browser cannot be technically prevented from repeating local writes after it has firmware bytes and a device handle. Roadex limits server authorization and audit semantics, uses fresh consent, closes handles, and avoids exposing reusable approvals; it does not describe the browser as a trusted enforcement boundary.

## Artifact Retrieval

- `GET /api/device-bridge/operations/:id/artifact` requires the operation credential and matching authenticated identity.
- Authorization is evaluated before artifact lookup or response body generation.
- The endpoint returns only the immutable bytes whose record is bound to the operation.
- Responses set an exact content length and approved binary media type, reject ranges in the first slice, forbid redirects, and use `Cache-Control: no-store`.
- The gateway must not buffer the artifact to logs or error bodies.
- The browser enforces the configured maximum while reading, computes SHA-256 with Web Crypto, compares it with the approved digest, and fails closed before any device write.

## Operation Lease And Cancellation

- The start response includes a short probe-phase deadline and event sequence starting point.
- Progress/result submissions are idempotent by operation ID and sequence number; duplicate sequence numbers return the prior acknowledgement.
- Probe submission validates normalized identity and verified artifact digest, then returns a short-lived confirmation challenge without write authority.
- After displaying the actual matched identity, verified artifact, and destructive warning, a fresh user gesture submits the challenge to `POST /api/device-bridge/operations/:id/authorize-write`. The server atomically rechecks current Roadex authorization and transitions an exact match to the destructive phase.
- The destructive-phase response includes a new short deadline and one-time phase nonce. Erase must begin immediately; the nonce cannot be exchanged or refreshed.
- Cancellation or revocation before erase closes the handle without writing.
- Erase and flash-write phases are non-cancellable because interruption may leave the device unbootable. The UI states this before approval.
- Logout, network loss, browser suspension, or destructive-phase deadline expiry during a non-cancellable phase causes the client to finish the current minimum safe transport step, close the handle, and report failure if connectivity returns.
- A separate bounded terminal-reporting grace period accepts only idempotent progress/final events. It cannot authorize probe, artifact retrieval, erase, or write and does not extend either operation phase.
- Recovery guidance requires reconnecting power, re-entering the bootloader, re-probing identity, and starting a new approved operation. An old approval or operation is never resumed.
- Server revocation cannot revoke browser-level USB permission or forcibly close a client handle. The design must state this limitation wherever revocation is described.

## Limits And Audit

- Limit concurrent device operations per user and per session.
- Bound descriptor, progress, and result payload sizes.
- Rate-limit capability, request, approval, start, artifact, and event endpoints separately from prompt submission.
- Record request, approval, denial, start, completion, cancellation, mismatch, expiry, and replay attempts.
- Never log approval or operation credentials, firmware bytes, cookies, gateway secrets, or raw personal device exports.

Device audit identifiers use an application-specific keyed HMAC of the normalized hardware identity. The key is separate from gateway credentials. Raw MAC, serial, and descriptor strings are not retained in general audit events. Bridge audit records are visible only to the owner and designated security administrators, use the existing state retention ceiling unless a shorter bridge-specific period is configured, and follow the same owner export/deletion process as Roadex session metadata. Progress and error fields are enum-based or server-sanitized; arbitrary browser/device text is discarded.

## Normative Web Security Requirements

- Device APIs are available only from the protected HTTPS secure context; loopback is permitted for local development tests only.
- Production responses set `Permissions-Policy: usb=(self), serial=(self)` and deny all framing with CSP `frame-ancestors 'none'`.
- Production CSP permits scripts only from Roadex's own hashed build assets, prohibits `unsafe-inline` and `unsafe-eval`, restricts connections to the protected Roadex origin, and loads no third-party scripts in the device workflow.
- State-changing requests require the protected gateway identity, exact same-origin `Origin`, JSON `Content-Type`, and a session-bound CSRF token delivered outside cookies.
- Reject missing, opaque, multiple, or mismatched Origin values before reading or parsing the request body.
- Operation credentials use authorization headers, are never placed in URLs, and are excluded from client logs and persisted browser storage.
- Authentication, ownership, lifecycle, and rate-limit checks occur before descriptor, artifact, or event body processing where protocol framing allows.
- The gateway permits only exact method/path pairs after independent review; encoded delimiters and extra path segments are denied.
- Transcript, project, device descriptor, progress, and error text is rendered as text only. Security tests inject markup and script payloads and verify they cannot create DOM elements, event handlers, URL loads, or script execution.

## Required API Shape

- `GET /api/device-bridge/capabilities`: return server policy and browser-neutral operation metadata.
- `POST /api/sessions/:id/device-bridge/requests`: validate a sanitized descriptor and create a pending approval request.
- `POST /api/device-bridge/requests/:id/approve`: require an explicit user action and issue a single-use approval.
- `POST /api/device-bridge/approvals/:id/start`: atomically consume approval and create an operation lease.
- `GET /api/device-bridge/operations/:id/artifact`: retrieve the immutable operation-bound artifact.
- `POST /api/device-bridge/operations/:id/probe`: verify probe identity and artifact digest and return a short-lived non-authorizing confirmation challenge.
- `POST /api/device-bridge/operations/:id/authorize-write`: consume the fresh user-confirmed challenge, recheck authorization, and atomically enter the destructive phase.
- `POST /api/device-bridge/operations/:id/events`: accept bounded, sequenced progress and final result events.
- `POST /api/device-bridge/operations/:id/cancel`: cancel before a non-cancellable phase or record a deferred cancellation.

Exact external gateway routes require an independent gateway and IDS review before exposure.

## Verification Gates

Before any real device access is enabled:

- unit tests for approval and operation scope, expiry, single use, replay rejection, payload bounds, and lifecycle revocation;
- authorization tests for cross-user, cross-session, and cross-project denial;
- artifact digest mismatch tests;
- artifact authorization, size, type, no-store, no-redirect, and client digest verification tests;
- device identity mismatch tests;
- Origin, CSRF, rate-limit, and protected-gateway route tests;
- browser capability tests for supported and unsupported platforms;
- Android hardware matrix tests for each supported board and USB-UART chipset;
- disconnect, reconnect, cancellation, and partial-flash failure tests;
- audit redaction tests;
- operation start atomicity, event idempotency, lease expiry, and mid-phase revocation tests;
- probe command allowlist, probe/write phase separation, expected-identity mismatch, pre-write reauthorization, destructive-phase nonce replay, and terminal-reporting grace tests;
- confirmation challenge expiry/replay tests and UI tests proving a fresh user gesture is required after the actual identity and digest are displayed;
- CSP and markup/script injection tests across transcript and device-controlled text;
- hardware verification with an explicitly identified non-production ESP32;
- Security Architect approval of server policy and client implementation;
- user approval of gateway/IDS changes and the first controlled hardware flash.

## Approval Boundary

Approval of this design permits implementation of disabled-by-default capability detection, typed contracts, artifact metadata, approval/operation storage, atomic start, and denial-path tests. It does not approve external gateway routes, production Permissions-Policy changes, browser device chooser calls, artifact byte delivery, USB handle access, or firmware flashing. Those remain separate approval gates.
