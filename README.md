[简体中文](./README.zh-CN.md)

# Lobster

> Constrained computer-use agent for macOS.

![macOS](https://img.shields.io/badge/macOS-14%2B-black?logo=apple)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-desktop-47848F?logo=electron&logoColor=white)
![Swift](https://img.shields.io/badge/Swift-6-FA7343?logo=swift&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-alpha-0F766E)

Lobster turns natural-language instructions into real, approval-aware desktop actions on a Mac.
It can open apps, inspect UI state, click, type, search files, and prepare handoffs while keeping risky steps behind explicit guardrails.

[Quick Start](./docs/quickstart.md) · [Features](#features) · [Architecture](./docs/architecture.md) · [Troubleshooting](./docs/troubleshooting.md) · [中文](./README.zh-CN.md)

## Features

- Real desktop execution on `macOS`
- Chat-driven control through `Telegram` or a local console
- Approval-first safety with `green`, `yellow`, and `red` levels
- File search and handoff preparation
- Native `Swift` bridge for actual desktop interaction
- Skill and workflow evolution with governance

## Why Lobster

Lobster is not an unrestricted automation bot.
It is designed for operators who want useful computer-use on a real Mac without losing traceability, approvals, or control.

## Choose Your Path

### 1. Local chat demo

Use this when you want the fastest first success without permissions work.

```bash
pnpm install
pnpm init:daemon
pnpm --filter lobsterd run chat:repl
```

### 2. Telegram remote control

Use this when you want to send `/chat` or `/do` commands from Telegram and have them land on your Mac.

```bash
pnpm --filter lobsterd run doctor
pnpm dev:daemon:oneclick
```

### 3. Real desktop control

Use this when you want Lobster to click, type, open apps, and inspect the UI on the local machine.

Grant `Accessibility`, `Screen Recording`, and `Automation` permissions in `System Settings -> Privacy & Security`, then start the daemon and desktop app.

```bash
pnpm dev:daemon:oneclick
pnpm dev:app
```

## Quick Start

1. Install dependencies.

```bash
pnpm install
```

2. Bootstrap local configuration.

```bash
pnpm init:daemon
```

3. Start the daemon and native bridge.

```bash
pnpm dev:daemon:oneclick
```

4. Open the desktop console or local REPL.

```bash
pnpm dev:app
pnpm --filter lobsterd run chat:repl
```

5. Check readiness and troubleshoot if needed.

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

## Safety Model

| Level | Meaning | Outcome |
| --- | --- | --- |
| `green` | Low-risk action with clear verification | Runs automatically |
| `yellow` | Allowed, but needs stronger checks | Stops for one-time approval |
| `red` | Outside the allowed boundary | Refused with explanation |

Lobster is intentionally conservative around sending, uploading, deleting, paying, changing security settings, and modifying hard safety rules.

## Docs

- [Quick Start](./docs/quickstart.md)
- [Architecture](./docs/architecture.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Use Cases](./docs/use-cases.md)
- [Chinese README](./README.zh-CN.md)

## Status

Lobster is an early-stage product, not a fully autonomous desktop AGI.
Its strongest areas today are operator-assisted workflows, approval-gated actions, Telegram ingress, file preparation, and native macOS control.
