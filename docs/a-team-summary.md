# Roadex Project Summary for The A-Team

## Intended Outcome

Roadex will be a browser-first portal for Codex users. It should provide an OpenAI Codex-like interface that feels like running Codex locally on the server, while allowing users to connect from desktop, mobile, and tablet devices.

The actual Codex process, project files, tools, and execution environment will run server-side. The browser client will act as the remote interface: sending user input, receiving streamed Codex responses, displaying project and session state, and supporting an interactive workflow similar in feel to SSH or a remote terminal session.

The first priority is a secure, usable browser portal across Windows, macOS, Linux, Android, iOS, tablets, and desktop browsers. Local client device and peripheral access will be added later, after the core portal, session management, project workflow, and security model are working. Future peripheral support should allow devices connected to the user's client machine to be made available to the server-side Codex session with explicit permissions. A flagship later workflow is flashing firmware to an ESP32 connected to an Android device over USB.

## Primary Users

- Codex users who want server-hosted Codex workspaces that can be accessed from any modern browser.
- Users working from mobile or constrained devices who still need server-side development tools, persistent project files, and long-running Codex sessions.
- Developers and maintainers responsible for operating secure shared Codex infrastructure.

## Major Components

- Responsive browser portal for desktop, mobile, and tablet.
- Server-side Codex session manager.
- Project workspace and file access layer.
- Real-time streamed chat and terminal-style interaction.
- Authentication, authorization, and user/session isolation.
- Secure audit logging and administrative oversight.
- Security review gates for sensitive actions.
- Later-stage client device and peripheral bridge.
- Later-stage USB/serial workflows, including ESP32 flashing from Android.

## Likely Risks

- Keeping browser sessions secure while exposing powerful server-side tools.
- Preventing cross-user leakage between projects, files, sessions, logs, and future device access.
- Handling long-running Codex work across network drops, mobile sleep states, and reconnects.
- Designing a UI that works well on desktop, tablet, and phone without losing terminal productivity.
- Safely introducing client peripheral access later without weakening the core security boundary.
- Platform restrictions for USB and device access, especially on iOS and some mobile browsers.
- Verifying that server-side execution cannot be abused through prompt, terminal, file, or device operations.

## Security And Verification

Roadex must include security oversight as a first-class design requirement. The architecture should define trust boundaries, permission checks, session isolation, audit logs, and review points before implementation reaches sensitive capabilities.

Verification should include security-focused tests for authentication, authorization, workspace isolation, command execution boundaries, logging, and future device access approval flows.

## Immediate Next Steps

1. Replace the placeholder Roadex summary with this confirmed direction.
2. Define the first browser portal experience and core user flow.
3. Choose the server-side Codex session model.
4. Design authentication, authorization, isolation, and audit requirements before app implementation.
5. Build the browser-first portal shell.
6. Add session streaming and project workspace interaction.
7. Defer client device access until the core portal is working and security-reviewed.
