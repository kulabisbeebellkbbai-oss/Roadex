# Roadex

Roadex is a browser-first portal for server-hosted Codex sessions. It is intended to feel like using Codex locally on the server while the user connects from a desktop, tablet, or mobile browser.

The first implementation milestone is a secure responsive portal shell. Server-side Codex process control, workspace streaming, authentication, and device bridging will be added behind explicit security review gates.

## Structure

- `src/` - browser application source code
- `tests/` - automated tests
- `assets/` - project assets
- `docs/` - planning and contributor notes

## Commands

- `npm install` - install frontend dependencies.
- `npm run dev` - start the Vite development server.
- `npm run build` - type-check and build the production bundle.
- `npm run lint` - run ESLint against the TypeScript source.
- `npm run test` - run the Vitest test suite.

## Current Status

The repository contains the first browser portal shell and project/security planning docs. Client device and peripheral access are intentionally deferred until the core portal, session model, and security controls are working and verified.
