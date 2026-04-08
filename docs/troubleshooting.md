# Troubleshooting

Use this page when the runtime starts but the actual workflow does not behave as expected.

## 1. Runtime does not start

Run:

```bash
pnpm --filter lobsterd run doctor
```

Check for:

- socket or data directory not writable
- missing or invalid model config
- missing bridge binary
- missing runtime env

Likely fixes:

- make sure `config/runtime.env` exists locally
- check the values in `config/models.yaml`
- run `pnpm init:daemon` again if you are unsure the local config is complete

## 2. Model is in stub mode

Run:

```bash
pnpm --filter lobsterd run model:probe
pnpm --filter lobsterd run doctor
```

Likely causes:

- model key missing from `config/runtime.env`
- provider config in `config/models.yaml` is incomplete
- the selected model endpoint is not reachable

Likely fixes:

- verify the provider key name and model id
- confirm the endpoint and proxy settings if you are behind a proxy
- retry after restarting the daemon

## 3. Telegram does not receive messages

Run:

```bash
pnpm --filter lobsterd run telegram:whoami
pnpm --filter lobsterd run telegram:doctor
pnpm --filter lobsterd run doctor
```

Likely causes:

- bot token is wrong
- network or proxy issue
- Telegram polling is disabled
- the allowlist blocks your chat id

Likely fixes:

- confirm the bot token in local config
- verify the proxy if you use one
- remove or update the chat allowlist while testing
- restart the daemon after fixing config

## 4. Desktop actions fail immediately

Run:

```bash
pnpm --filter lobsterd run doctor
pnpm dev:daemon:oneclick
```

Likely causes:

- `Accessibility` permission not granted
- `Screen Recording` permission not granted
- the native bridge was not prepared
- the target app is not installed or not visible

Likely fixes:

- open `System Settings -> Privacy & Security`
- grant the required permissions to the bridge and related apps
- re-run the one-click daemon start

## 5. Chat works, but `/do` does not

This usually means the runtime is healthy but the computer-use path is blocked.

Check:

- bridge readiness
- macOS permissions
- whether the action is `yellow` and waiting for approval
- whether the model produced a safe fallback instead of a real action

## 6. I am not sure what to do next

Use this short order:

```bash
pnpm --filter lobsterd run doctor
pnpm --filter lobsterd run telegram:doctor
pnpm --filter lobsterd run chat:repl
```

If chat works but Telegram does not, focus on bot config and networking.
If Telegram works but desktop control does not, focus on macOS permissions and bridge readiness.

## 7. Reset and retry

If you want to clear local runtime state and start over:

```bash
pnpm reset:daemon
pnpm init:daemon
```

Use this when config drift or stale state is causing confusing behavior.
