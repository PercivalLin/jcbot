# Contributing to Lobster

Lobster is an early-stage, approval-gated macOS computer-use project. Keep contributions small, reviewable, and safe by default.

## Before you open a PR

- Run `pnpm typecheck` and `pnpm test`.
- Do not commit `config/runtime.env`, secret files, certs, logs, or build outputs.
- Keep changes scoped to one behavior or one doc flow where possible.
- Update docs if you change setup, permissions, safety rules, or user-facing behavior.

## Branches and commits

- Use a focused branch name.
- Write an imperative commit message that matches the actual change.
- Avoid history rewrites unless you are explicitly asked to do that.

## Review expectations

- Include reproduction steps for bug fixes.
- Include screenshots or short recordings for UI changes when possible.
- If you change computer-use behavior, describe the safety impact.

## Good first contributions

- README clarity improvements
- docs and troubleshooting updates
- tests for orchestration and policy behavior
- small UI polish in the desktop console
