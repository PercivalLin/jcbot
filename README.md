# Lobster

Lobster is a TypeScript-first, macOS-native computer-use agent that turns chat instructions into constrained desktop actions. It combines:

- an Electron operator console for runs, approvals, replay, and settings
- a Node.js/TypeScript runtime for planning, constraints, inboxes, skills, and model routing
- a Swift bridge for Accessibility-driven observation, input injection, and hard policy enforcement

GitHub short description:

TypeScript-first macOS computer-use agent with Electron + Node.js + Swift, approval-gated desktop automation, Telegram ingress, and pluggable chat-app workflows.

Core components:

- `lobster-app`: Electron desktop shell for runs, approvals, replay, and settings
- `lobsterd`: Node/TypeScript runtime for planning, constraints, skills, inboxes, and evolution
- `lobster-bridge`: Swift bridge for macOS Accessibility, screen capture, input injection, and policy enforcement

## Workspace layout

- `apps/desktop`: Electron + React shell
- `services/lobsterd`: orchestration daemon, JSON-RPC, inboxes, skills, evolution lab
- `packages/shared`: shared types and schemas
- `packages/policy`: constitution engine, self-check, policy gate, approval tokens
- `packages/storage`: SQLite schema and repositories
- `packages/skills`: declarative starter skills
- `native/lobster-bridge`: Swift 6 bridge service
- `config`: machine-readable model and constitution config

## Current status

This repository now contains a working v1 runtime skeleton:

- TS monorepo and package boundaries
- machine-readable constitution, self-check, hard redline gate, and one-shot approval tokens
- `Observe -> Plan -> Self-Check -> Risk Gate -> Act -> Verify` runtime loop
- recover loop for green actions (`Verify -> Retry once -> Recover/Fail`) to improve real-world stability
- Unix-socket JSON-RPC daemon with persistent runs, approvals, inbox items, and capability candidates
- Telegram polling ingress for private-chat commands and approval command parsing (`/approve <ticketId>` / `/deny <ticketId>`)
- Local standalone chat ingress (`desktop console + local chat REPL`) for direct one-to-one usage without third-party chat tools
- configurable chat plugin registry (`config/chat_plugins.yaml`) for WeChat/WhatsApp-style adapters
- generic chat-plugin fallback: if a known chat app is mentioned but not explicitly configured, Lobster auto-applies `ChatAppPluginTemplate` strategy hints
- chat-plugin auto-inference: if chat intent is clear but app name is omitted, Lobster picks an enabled chat plugin (or active/discovered chat app) for contact-selection planning
- bridge-side application search fallback: when a referenced app is not in known aliases, Lobster queries installed apps and can still plan `ui.open_app`
- chained natural-language planning: supports multi-step UI plans from one message (`open -> click -> type -> hotkey/scroll`)
- Electron operator console for runs, approvals, inbox, model profiles, and bridge capabilities
- starter `ChatAppPluginTemplate` for adapter-style chat integrations (chat apps are runtime plugin instances, not core hardcoding)
- Swift bridge with hard-gate enforcement, active-app/window observation, AX candidate discovery, candidate `value/focused` metadata, and minimal `open_app` / `activate_app` / `focus_target` / `type_text` / `type_into_target` / `click` / `click_target` / `scroll` / `hotkey` actions
- role-aware AX target matching (`label + role + focused` scoring) for semantic click/input actions
- semantic post-action verification for app activation, focus changes, and target-aware text entry
- evolution lab with safety-gated auto-staging (`green + replay/trace evidence`) and staging observation review to `stable/held`
- test coverage for policy, ingress, persistence fallback, notification follow-up, and approval resume flow

## Public repo boundary

Public/safe to upload:

- source code, docs, tests, and package manifests
- `config/constitution.yaml`
- `config/chat_plugins.yaml`
- `config/models.yaml`
- `config/runtime.env.example`

Keep local only:

- `config/runtime.env`
- `config/secrets/*`
- `config/certs/*`
- runtime databases, logs, coverage, and temporary artifacts
- compiled bridge and desktop build outputs

See [GitHub publish notes](docs/github-publish.md) for the upload checklist and public-vs-local boundary.

## Bootstrapping

1. Install Node.js 22 and pnpm.
2. Run `pnpm install`.
3. Run first-run wizard (shell/TUI): `pnpm init:daemon`
4. Start daemon (will auto-enter wizard if not initialized): `pnpm dev:daemon`
5. One-click mode (auto-prepare bridge, then start): `pnpm dev:daemon:oneclick`
6. Optionally edit `config/chat_plugins.yaml` to define enabled chat app instances, aliases, and per-app UI strategy labels.
7. Run `pnpm --filter lobsterd run doctor` to verify model/env/bridge/chat readiness.
8. Choose one chat entry:
   - `pnpm --filter lobsterd run chat:repl` (terminal single-chat bot)
   - `pnpm dev:app` (desktop single-chat console)
9. Verify a real model round-trip quickly: `pnpm --filter lobsterd run model:probe -- --strict`

Reset from scratch:
- Preview reset scope: `pnpm reset:daemon -- --dry-run`
- Execute reset: `pnpm reset:daemon -- --yes`

The wizard writes:

- `config/runtime.env` (Telegram + key refs + runtime env, local only, do not commit)
- `config/models.yaml` (can generate OpenAI-compatible profiles for all roles)

Useful runtime env vars:

- `LOBSTER_SOCKET_PATH`: Unix socket path for `lobsterd`
- `LOBSTER_DATA_PATH`: SQLite path; if `better-sqlite3` is unavailable, Lobster falls back to a JSON persistence file beside it
- `LOBSTER_ENV_PATH`: optional runtime env file override (defaults to `config/runtime.env`)
- `LOBSTER_MODELS_PATH`: optional models file override (defaults to `config/models.yaml`)
- `LOBSTER_TELEGRAM_BOT_TOKEN`: enable Telegram polling ingress + Telegram run notifications
- `LOBSTER_TELEGRAM_BOT_TOKEN_FILE`: optional file-based secret reference (relative to `runtime.env` path), for example `secrets/telegram_bot_token.txt`
- `LOBSTER_TELEGRAM_BASE_URL`: Telegram API base URL (default `https://api.telegram.org`)
- `LOBSTER_TELEGRAM_PROXY_URL`: optional HTTP proxy for Telegram API calls (example `http://127.0.0.1:7897`)
- `LOBSTER_TELEGRAM_POLL_INTERVAL_MS`: poll backoff when errors happen (default `1500`)
- `LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS`: optional comma-separated Telegram chat IDs allowlist (discover quickly via `pnpm --filter lobsterd run telegram:whoami`)
- `LOBSTER_TELEGRAM_TEXT_MODE`: Telegram text routing mode: `task`, `chat`, or `hybrid` (default)
- `LOBSTER_TELEGRAM_TRACE`: Telegram ingress terminal trace switch (`1` default, set `0` to disable inbound message logs)
- `LOBSTER_TELEGRAM_TASK_ACK`: Telegram task receive-ack switch (`1` default, set `0` to disable immediate `收到，正在处理...` ack)
- `LOBSTER_LOCAL_CHAT_USER_ID`: optional local chat identity used by `chat:repl` (default `local-cli-user`)
- `LOBSTER_NOTIFICATION_WHITELIST`: optional comma-separated app list for notification-triggered follow-up tasks
- `LOBSTER_BRIDGE_BIN`: optional compiled Swift bridge binary path
- `LOBSTER_BRIDGE_ARGS`: optional space-delimited bridge args
- `LOBSTER_KNOWN_APPS`: optional comma-separated app names merged into the runtime app catalog and synced to bridge
- `LOBSTER_CHAT_PLUGINS_PATH`: optional chat plugin registry path (defaults to `config/chat_plugins.yaml`)
- `OPENAI_COMPATIBLE_API_KEY_FILE`: optional file-based secret reference (relative to `runtime.env` path), for example `secrets/openai_compatible_api_key.txt`
- `NODE_EXTRA_CA_CERTS`: optional CA bundle path for TLS verification (relative to `runtime.env` path is supported), for example `certs/globalsign-chain.pem`
- `LOBSTER_CHAT_TRACE`: terminal chat trace switch (`1` default, set `0` to disable)
- `LOBSTER_MODEL_TRACE`: terminal model trace switch (`1` default, set `0` to disable)

When both plain env var and `*_FILE` are present, Lobster prefers the plain env var value and only falls back to `*_FILE`.

## AI model wiring

Lobster reads model profiles from `config/models.yaml`.

Bootstrap wizard supports `openai-compatible` first-class:

- one shared `baseURL`
- one `apiKeyRef`
- per-role `modelId` (planner/vision/executor/critic)

- `planner` default key ref: `OPENAI_API_KEY`
- `vision` default key ref: `ANTHROPIC_API_KEY`
- `executor` default key ref: `GOOGLE_GENERATIVE_AI_API_KEY`
- `critic` can run local `openai-compatible` endpoints (for example `http://localhost:11434/v1`) without a key if local access works

Quick shell example:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export GOOGLE_GENERATIVE_AI_API_KEY=...
pnpm dev:daemon
```

If a profile has no usable credential, Lobster falls back to a local stub response for that role.

## Chat ingress

### Local single-chat (no third-party dependency)

```bash
pnpm dev:daemon
pnpm --filter lobsterd run chat:repl
```

You can then chat directly in terminal and run commands such as:
- normal sentence: create task
- `/runs`: list recent runs
- `/approvals`: list pending approvals
- `/approve <ticketId>` / `/deny <ticketId>`

### Telegram single-chat (recommended remote channel)

```bash
pnpm init:daemon
pnpm --filter lobsterd run telegram:doctor
pnpm --filter lobsterd run telegram:whoami
pnpm --filter lobsterd run doctor
pnpm dev:daemon
```

`telegram:whoami` validates the bot token and prints detected `chat_id` values from recent messages so you can set allowlist quickly.
`telegram:doctor` checks baseURL/token reachability and prints actionable network hints (DNS / timeout / invalid token).

Telegram command routing:
- `/do <instruction>`: always create execution task
- `/chat <message>`: always chat-only reply (no action execution)
- plain text behavior is controlled by `LOBSTER_TELEGRAM_TEXT_MODE`:
`task`: all plain text => task
`chat`: all plain text => chat-only reply
`hybrid`: auto-detect (operation-like text => task, otherwise chat)

Base URL rule:
- Keep only host prefix, for example `https://api.telegram.org`.
- Do not include `/bot<token>` or method path in `LOBSTER_TELEGRAM_BASE_URL`.

Optional hardening:
- set `LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS` to only allow your own chat id(s)
- keep desktop app open for approvals and run replay (`pnpm dev:app`)

## Fast path (Telegram + AI + Native bridge)

1. Build bridge:

```bash
cd native/lobster-bridge
swift build -c release
cd ../..
export LOBSTER_BRIDGE_BIN="$PWD/native/lobster-bridge/.build/release/lobster-bridge"
```

2. Set model keys (you can start with only one provider):

```bash
pnpm init:daemon
```

3. Set Telegram token and discover your chat id:

```bash
export LOBSTER_TELEGRAM_BOT_TOKEN=<bot_token>
pnpm --filter lobsterd run telegram:whoami
```

4. Restrict trigger source (recommended):

```bash
export LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS=<chat_id_from_whoami>
```

5. Run readiness check and start daemon:

```bash
pnpm --filter lobsterd run doctor
pnpm dev:daemon
```

6. (Optional but recommended) open desktop console for approvals/logs:

```bash
pnpm dev:app
```

## macOS permission grant

For real computer-use actions, grant permissions to the bridge binary (and the parent app/terminal that launches it):

- Accessibility
- Screen Recording
- Automation (when cross-app control is needed)

Suggested check path:

`System Settings -> Privacy & Security`

Without these, Lobster may still run but action execution and observation are limited.

The workspace currently targets macOS and expects Accessibility, Screen Recording, and Automation permissions for the native bridge.

The desktop console now includes a `Runtime Readiness` panel driven by daemon-side checks (`runtime.readiness`) to surface missing permissions/configuration quickly.

Current caveats:

- If `better-sqlite3` native bindings are not built, runtime persistence falls back to JSON automatically.
- The Swift bridge is no longer pure stub, but it is still only a minimal action layer; AX tree querying, OCR, robust target matching, and screenshot capture are not wired yet.
- The Electron package is scaffolded and built, but local Electron runtime still depends on native postinstall approval in this environment.
