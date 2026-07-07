# Maya Roadmap

**Maya = a local-first AI operating system for developers.** One command boots a
model gateway (cloud + local GGUF), coding-agent orchestration, Maya's own agent
message bus, a Loop Agent team lead, and a dashboard — all Apple Silicon
(M1 →), never crashing the host, no shortcuts.

This is the master plan. Each phase has a detailed doc in [`docs/phases/`](./phases/)
covering goal, features (owner-brief vs **NEW**), deliverables, acceptance
criteria, and risks. Lanes: **02 = model plane**, **01 = agent plane** (see
`packages/core/src/contracts/README.md`).

## Phase map

| # | Phase | Lane | Depends on | One-liner |
|---|-------|------|-----------|-----------|
| 0 | [Foundation](./phases/phase-00-foundation.md) | 02 (done) | — | Monorepo, contracts, config, CLI skeleton |
| 1 | [Model Runtime Core](./phases/phase-01-model-runtime.md) | 02 | 0 | llama-server supervision, GGUF pulls, degrade-not-crash guardrails |
| 2 | [Gateway](./phases/phase-02-gateway.md) | 02 | 1 | One OpenAI+Anthropic-compatible endpoint over local + 7 cloud providers |
| 3 | [Maya Bus](./phases/phase-03-bus.md) | 01 | 0 | Our own WebSocket message bus: channels, tokens, roles, policy |
| 4 | [Agent Runtime](./phases/phase-04-agent-runtime.md) | 01 | 2, 3 | AgentAdapter + Claude Code/Codex/OpenCode on any model |
| 5 | [CLI & TUI](./phases/phase-05-cli-tui.md) | 02 | 1, 2 | `maya` boot supervisor + Ink TUI + onboarding wizard |
| 6 | [Teams & Orchestrator](./phases/phase-06-orchestrator.md) | 01 | 3, 4 | Team CRUD, topologies, task state machine |
| 7 | [Loop Agent](./phases/phase-07-loop-agent.md) | 01 | 6 | The interim team lead — the differentiator |
| 8 | [Dashboard](./phases/phase-08-dashboard.md) | split | 2, 3, 4 | Models/Agents/Teams/Tasks/Conversations, live |
| 9 | [Persistence & Projects](./phases/phase-09-persistence.md) | 02 | 0 | SQLite schema, projects, runs, artifacts, search |
| 10 | [Packaging & Distribution](./phases/phase-10-packaging.md) | 02 | 5 | `npx maya-os` polish, releases, migrations, brew tap |
| 11 | [MLX Backend](./phases/phase-11-mlx-backend.md) | 02 | 1 | Second runtime backend + per-model benchmark auto-pick |
| 12 | [Plugin SDK](./phases/phase-12-plugin-sdk.md) | 01 | 2, 4, 8 | Everything becomes a plugin |
| 13 | [Hardening & Performance](./phases/phase-13-hardening.md) | 02 | 1–8 | Chaos suite, perf gates, security audit, soak |
| 14 | [Distributed & Future](./phases/phase-14-future.md) | 01 | 13 | Multi-Mac execution, cloud burst, RAG, marketplace |

## Milestones → phases

| Milestone | Meaning | Phases |
|-----------|---------|--------|
| **M0** ✅ | Repo builds, contracts frozen, `maya status` runs | 0 |
| **M1** | One pulled GGUF served at `localhost:4100/v1/*`, degrades under RAM pressure instead of crashing | 1, 2 |
| **M2** | A Claude Code agent spawned by Maya, running on a local model, joined to the bus | 3, 4, 5 |
| **M3** | Loop demo: lead + 2 workers deliver a task with ≤1 human question | 6, 7 |
| **M4** | Dashboard v0: watch all of the above live | 8, 9 |
| **M5** | Public: `npx maya-os` cold-start on a clean Mac in <2 min | 10, 11, 12, 13 |

## Owner constraints (standing)

- All Apple M-series (M1 →); guardrail defaults must be safe on 8 GB.
- Never crash the host: degrade (quant → context) before refusing; kill + restart hung processes.
- Node is the control plane; inference stays native (llama.cpp Metal / MLX). Node for the TUI.
- Stability + speed, no shortcuts (~4-week horizon).
- Bus is Maya's own code; `~/work/colate/cana-web` is read-only reference.
- MIT, npm `maya-os`, binary `maya`, internals `@maya-ai/*`.
