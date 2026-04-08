# Quick Start

This repository is easiest to approach in three separate tracks. Pick the one that matches what you want to verify first.

## Track 1: Local chat demo

Use this if you want to confirm that the runtime starts and can answer in chat without touching the desktop.

```bash
pnpm install
pnpm init:daemon
pnpm --filter lobsterd run chat:repl
```

What you should see:

- the daemon starts
- the chat REPL opens
- `/chat hello` gets a text response
- no macOS permissions are required for this track

## Track 2: Telegram remote control

Use this if you want to send instructions from Telegram and have them enter the runtime.

```bash
pnpm --filter lobsterd run telegram:whoami
pnpm --filter lobsterd run telegram:doctor
pnpm --filter lobsterd run doctor
```

What you should verify:

- the bot token is configured
- Telegram polling is enabled
- the chat allowlist matches your account if you use one
- the runtime is not falling back to stub models unless that is intentional

If Telegram does not receive messages, start with the troubleshooting page.

## Track 3: Real desktop control

Use this when you want Lobster to actually operate macOS apps.

```bash
pnpm dev:daemon:oneclick
pnpm dev:app
```

Before this track works, grant the native bridge the required permissions in macOS settings:

- `Accessibility`
- `Screen Recording`
- `Automation`

Expected result:

- the bridge prepares successfully
- the desktop app opens
- you can issue a `/do ...` task and see real desktop actions

## Recommended First Success Path

1. Run `pnpm install`.
2. Run `pnpm init:daemon`.
3. Run `pnpm --filter lobsterd run doctor`.
4. Start `pnpm --filter lobsterd run chat:repl`.
5. Send `/chat hello`.
6. If that works, move to Telegram.
7. If Telegram works, grant macOS permissions and try desktop control.

## Minimum Config You Need

Lobster expects local configuration files under `config/`. The most important ones are:

- `config/runtime.env`
- `config/models.yaml`
- `config/chat_plugins.yaml`
- `config/constitution.yaml`

Use the `*.example` files as the starting point and keep real secrets local.

## Smoke Test

When everything is wired correctly, this should be a short sanity check:

```text
/chat hello
/do open Finder
pnpm --filter lobsterd run doctor
```

If the first command works but the second one fails, the issue is usually permissions or bridge readiness.
