# Lobster Architecture

## Processes

- `lobster-app`: Electron renderer and shell
- `lobsterd`: Node/TypeScript orchestration daemon
- `lobster-bridge`: Swift macOS bridge

## Execution loop

1. `Observe`
2. `Plan`
3. `Self-Check`
4. `Risk Gate`
5. `Act`
6. `Verify`
7. `Recover`

## Hard constraints

- Redline actions require hard blocking
- Yellow actions require strong verification and can be single-use approved
- Green actions can auto-execute

## Evolution flow

1. Mine traces
2. Generate candidate skill or prompt pack
3. Replay in sandbox
4. Risk classify
5. Auto-promote low-risk declarative candidates to staging
6. Require manual approval for all other candidates

