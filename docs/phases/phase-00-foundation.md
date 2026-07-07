# Phase 0 — Foundation ✅ (done 2026-07-08)

**Lane:** 02 · **Depends on:** — · **Milestone:** M0

## Goal

A repo two agents (and later, contributors) can build in parallel without
stepping on each other: frozen cross-lane contracts, one workspace, a CLI
entry point that proves the toolchain end-to-end.

## Shipped

| Feature | Source | Notes |
|---------|--------|-------|
| pnpm + TypeScript strict/ESM/NodeNext monorepo (`apps/*`, `packages/*`) | brief | Node ≥22.5 so `node:sqlite` needs no native builds |
| Cross-lane contracts as per-domain files (`packages/core/src/contracts/`) | brief | `models` `agents` `loop` `bus` `config` + README with change rules (PR + both lanes sign off) |
| `ModelId` = `provider/name` template-literal type | **NEW** | Compile-time enforcement that layers never address raw ports/processes |
| Plain-data `AgentHandle` (methods live on adapters) | **NEW** | Handles survive JSON/HTTP/SQLite round-trips across processes |
| Loop protocol v1 — 8 kinds incl. `task_accept` (crash-safe claims), `scope`, `acceptance` | **NEW** | Beyond the brief's 5: explicit claims, parallelization scope, definition-of-done |
| `@maya-ai/core` config loader + `~/.maya` layout | brief | Guardrail defaults sized for 8 GB M1 |
| `maya-os` CLI skeleton (`maya status`, `--version`) | brief | Boot supervisor lands in Phase 5 |
| MIT license, `maya-os`/`maya`/`@maya-ai/*` naming | owner | Locked on-channel 2026-07-08 |
| STACK.md — Node control plane, native inference | owner | "JS never touches tokens/sec" |

## Acceptance (all verified)

- `pnpm install && pnpm -r build` green on a clean clone.
- `maya status` prints ports/paths from a default config; `--version` works.
- Both lanes agree the contracts compile and cover their plane.
