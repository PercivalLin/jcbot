# Contributing to Lobster

Lobster is an early-stage, approval-gated macOS computer-use project. Keep contributions small, reviewable, and safe by default.

## Core engineering principle

First-principles reasoning is the project's top development rule.

- Start from what must be true in the real system, not from analogy or UI-level assumptions.
- Prefer explicit state, explicit contracts, and verifiable evidence over heuristics hidden in prompts or glue code.
- When a feature is brittle, reduce it to observation, decision, execution, and verification, then fix the weakest layer directly.
- If a shortcut conflicts with reliability, recoverability, or operator trust, choose the more fundamental design even if it takes longer.

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
