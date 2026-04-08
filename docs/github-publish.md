# GitHub Publish Notes

## Suggested repository description

TypeScript-first macOS computer-use agent with Electron + Node.js + Swift, approval-gated desktop automation, Telegram ingress, and pluggable chat-app workflows.

## What should go to GitHub

- Source code under `apps/`, `services/`, `packages/`, and `native/`
- Public docs under `README.md` and `docs/`
- Safe config files such as `config/constitution.yaml`, `config/chat_plugins.yaml`, and `config/models.yaml`
- Public bootstrap examples such as `config/runtime.env.example`
- Workspace manifests such as `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `tsconfig.base.json`

## What should stay local

- `config/runtime.env`
- `config/secrets/*`
- `config/certs/*`
- Local database files and JSON fallback persistence
- Native build outputs, Electron build outputs, coverage, logs, and temporary artifacts
- macOS metadata files such as `._*` and `.DS_Store`

## Difference between the public repo and your current local workspace

- Your local workspace can keep real bot tokens, model keys, proxy settings, and machine-specific bridge paths in `config/runtime.env`.
- The public repo should only contain `config/runtime.env.example`, never the real `config/runtime.env`.
- Your local workspace may contain compiled bridge binaries, Electron outputs, runtime databases, and temporary traces.
- The public repo should exclude those via `.gitignore`.

## Publish checklist

1. Make sure `config/runtime.env` is not staged.
2. Make sure `config/secrets/` and `config/certs/` are not staged.
3. Review `git status --ignored` once before the first public push.
4. Keep `config/runtime.env.example` up to date whenever you add new runtime variables.
5. Rotate any bot token or API key that may already have been copied, logged, or staged outside this machine.
