# Maya

**A local-first AI operating system for developers.** One command boots a model
gateway (cloud + local GGUF), coding-agent orchestration, an agent message bus,
and a dashboard — optimized for Apple Silicon (all M-series, M1 →).

- npm: `maya-os` · CLI binary: `maya` · internal packages: `@maya-ai/*`
- License: MIT

## Layers

| Layer | Package | Lane |
|-------|---------|------|
| Model runtime (GGUF via llama.cpp/Metal, MLX later) + guardrails | `packages/model-runtime` | 02 |
| Gateway (OpenAI- & Anthropic-compatible, cloud + local routing) | `packages/gateway` | 02 |
| Agent adapters (Claude Code, Codex, OpenCode, …) | `packages/agent-runtime` | 01 |
| Message bus (Maya's own, walkie-talkie-style protocol) | `packages/bus` | 01 |
| Teams + Loop Agent (persistent interim team lead) | `packages/orchestrator` | 01 |
| Shared contracts, config, SQLite | `packages/core` | shared (02 scaffolds) |
| CLI (`npx maya-os`) | `apps/cli` | 02 |
| Dashboard | `apps/dashboard` | split by tabs |

Contracts live in `packages/core/src/contracts/` — see its README. Quality bar:
never crash the host Mac, degrade before refusing, no shortcuts.

## The Maya OS family

| | What it is | Source | Package |
|---|---|---|---|
| **Maya OS** | The platform — gateway, agent teams, orchestrator, dashboard | [Maya-os](https://github.com/iamthehimansh/Maya-os) | [`maya-os`](https://www.npmjs.com/package/maya-os) |
| **maya code** (`mayac`) | The coding agent — Ink TUI, Anthropic + OpenAI, skills, MCP | [Mayac](https://github.com/iamthehimansh/Mayac) | [`@maya-os/code`](https://www.npmjs.com/package/@maya-os/code) |
| **Landing page** | The site at [maya.himansh.in](https://maya.himansh.in) | [Maya-landing](https://github.com/iamthehimansh/Maya-landing) | — |

Website: **[maya.himansh.in](https://maya.himansh.in)** · Docs: **[maya.himansh.in/docs](https://maya.himansh.in/docs)**
