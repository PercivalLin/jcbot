[简体中文](./README.zh-CN.md)

# Lobster

> Constrained computer-use for macOS.

`Lobster` is a `TypeScript-first` desktop agent built with `Electron + Node.js + Swift`.
It receives natural-language instructions from `Telegram` or a local console, then opens apps, inspects UI state, types, clicks, searches for files, prepares handoffs, and reports progress under explicit approval-aware guardrails.

## Why Lobster

Lobster is not trying to be an unrestricted automation bot.
It is designed for operators who want real computer-use on a real Mac, but still need boundaries, approvals, and traceability.

- It works with actual desktop apps, not just browser tabs.
- It keeps risky actions behind approvals instead of silently executing them.
- It can be driven remotely through chat while still running on your own machine.
- It records runs, approvals, and outcomes so failures are debuggable.

## Product Highlights

### Real desktop execution

- Open and focus applications.
- Inspect UI trees and visible targets.
- Click, type, scroll, and trigger keyboard actions.
- Search for local files and prepare them for handoff.

### Chat-driven control

- Accept instructions from `Telegram`.
- Support local operator flows through the desktop console and REPL.
- Separate chat-only interactions from action-execution flows with `/chat` and `/do`.

### Approval-first safety model

- `green`: execute automatically.
- `yellow`: require stronger verification and one-time approval.
- `red`: never auto-execute and never bypass.

### Built for extension

- Pluggable chat-app strategies.
- Configurable model routing.
- Skill and workflow evolution with explicit governance.
- Native macOS bridge for real computer-use instead of browser-only simulation.

## Example Workflows

- Open `Finder`, locate a document, and prepare it for transfer in a chat app.
- Inspect an incoming notification, open the related app, and summarize what needs attention.
- Draft a reply or file handoff, then stop at approval instead of sending automatically.
- Search for a local file by name when the user only gives a fuzzy natural-language request.

## How It Works

```mermaid
flowchart LR
    A["Telegram / Local Console"] --> B["Task Orchestrator"]
    B --> C["Observe"]
    C --> D["Plan"]
    D --> E["Self-Check"]
    E --> F["Policy Gate"]
    F --> G["Act"]
    G --> H["Verify / Recover"]
    H --> I["Logs / Approvals / Result"]
```

## Safety Model

| Level | Meaning | Typical Outcome |
| --- | --- | --- |
| `green` | Low-risk action with clear verification | Runs automatically |
| `yellow` | Action is allowed, but needs stronger checks | Stops for one-time approval |
| `red` | Outside the allowed boundary | Refused with explanation and safer alternatives |

Lobster is intentionally conservative around actions such as sending, uploading, deleting, paying, changing security settings, or modifying its own hard safety rules.

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Run the bootstrap wizard

```bash
pnpm init:daemon
```

This generates local runtime configuration such as model credentials, transport settings, and operator preferences.

### 3. Start the daemon

```bash
pnpm dev:daemon:oneclick
```

This prepares the native bridge first and then starts `lobsterd`.

### 4. Pick an operator surface

Desktop console:

```bash
pnpm dev:app
```

Local chat REPL:

```bash
pnpm --filter lobsterd run chat:repl
```

### 5. Check runtime readiness

```bash
pnpm --filter lobsterd run doctor
```

## Command Examples

```text
/chat hello
/do open Finder and search for rbcc notes
/do prepare the selected file for WeChat File Transfer Assistant
/approve <ticketId>
/deny <ticketId>
```

## macOS Permissions

For real desktop control instead of stub behavior, grant the native bridge the required permissions in:

`System Settings -> Privacy & Security`

Required permissions:

- `Accessibility`
- `Screen Recording`
- `Automation` for cross-app control

## Tech Stack

- `apps/desktop`: Electron operator console
- `services/lobsterd`: orchestration runtime and IPC service
- `native/lobster-bridge`: Swift macOS bridge
- `packages/policy`: approval and constraint engine
- `packages/storage`: SQLite and JSON fallback persistence
- `packages/skills`: starter skills and application catalog

## Repository Layout

- `apps/desktop`: desktop control surface
- `services/lobsterd`: main daemon
- `packages/*`: shared runtime packages
- `native/lobster-bridge`: native macOS control bridge
- `config/*`: public configuration templates and policies

## Public Repository Notes

Safe to publish:

- source code
- docs
- tests
- `config/runtime.env.example`
- `config/models.yaml`
- `config/chat_plugins.yaml`
- `config/constitution.yaml`

Keep local only:

- `config/runtime.env`
- `config/secrets/*`
- `config/certs/*`
- logs, databases, temporary runtime state, and build artifacts

## Status

Lobster is already beyond a pure prototype: the current focus is turning it into a reliable early-stage product for constrained desktop operations on `macOS`.

It is strongest today in operator-assisted workflows, approval-gated actions, Telegram ingress, file preparation, and desktop control primitives. It is not positioned as a fully autonomous general desktop AGI system.
