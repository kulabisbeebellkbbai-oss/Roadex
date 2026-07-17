# Repository Guidelines

## Project Structure & Module Organization

Keep source code in `src/`, tests in `tests/`, assets in `assets/`, and contributor notes in `docs/` as the project grows. Keep `.agents/` and `.codex/` for local agent metadata.

## A-Team Workflow

Roadex development must use The A-Team workflow. Keep the high-level summary in `docs/a-team-summary.md`, keep the active team plan in `docs/a-team-plan.md`, and assign development work through the approved A-Team roles before implementation. If The A-Team MCP server is unavailable, stop and report the blocker instead of silently falling back to single-agent development.

## Build, Test, and Development Commands

Document project-specific commands here when a build system is added. Include install, run, test, and lint commands with one-line explanations.

## Coding Style & Naming Conventions

Follow the conventions of the language and framework used in this project. Prefer descriptive module names and small, focused files.

## Testing Guidelines

Add tests with new behavior and mirror the source layout where practical. Name tests after the behavior they verify.

## Commit & Pull Request Guidelines

Use clear imperative commit messages. Pull requests should include a short summary, test results, and relevant screenshots for UI changes.
