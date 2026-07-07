# Maya stack (locked 2026-07-08, owner-directed: perf-first, Node for TUI)

Principle: **Node/TypeScript is the control plane; the hot path (inference) is
native C++/Metal via llama.cpp — JS never sits in the token path.** One
language across the repo keeps the plugin SDK, npm distribution, and
contributor story simple; native deps are allowed only where unavoidable.

| Layer | Stack | Why (performance) |
|-------|-------|-------------------|
| CLI + TUI (`apps/cli`) | Node + TypeScript + **Ink** + commander | Owner preference (Node TUI); Ink = rich interactive terminal UI (same approach as Claude Code/Codex CLIs); tsup-bundled ESM for instant startup |
| Gateway (`packages/gateway`) | Node + **Hono** + undici | Fastest modern TS HTTP framework; first-class streaming (SSE/chunked pass-through) for token streams |
| Model runtime (`packages/model-runtime`) | Node supervisor → **`llama-server`** (C++/Metal) child processes; **MLX** backend phase 2 | Real perf lives in llama.cpp's Metal kernels; Node supervises (spawn/health, RAM via `vm_stat`/`sysctl`). Zero JS in the token path |
| Bus (`packages/bus`) | Node + **`ws`** + zod (+ Hono for REST: token mint, history) | Local agent traffic is dozens of connections; `ws` is battle-tested. uWebSockets.js rejected: native-dep pain for no felt gain |
| Agent runtime (`packages/agent-runtime`) | Node + **node-pty** + execa | node-pty (native, unavoidable) drives real agent CLIs through a PTY; everything else pure TS |
| Orchestrator / Loop (`packages/orchestrator`) | Pure TypeScript state machines; SQLite-backed task state | Deterministic control flow; the lead's own LLM calls go through our gateway (dogfooding) |
| Dashboard (`apps/dashboard`) | **React + Vite + Tailwind**; live data via bus WS + gateway SSE; **uPlot** charts | Local SPA served statically by the CLI process (no SSR server); uPlot = fastest live time-series |
| Persistence (`packages/core`) | **`node:sqlite`** (built into Node ≥ 22.5) | Zero native-compile risk across M1→M4; keeps node-pty the only native module |
| Tooling | **pnpm** workspaces + **tsup** + **vitest** + **biome** | Fast installs/builds/tests/lint; single tool per job |

Rejected: Rust/Go services (would speed up nothing — control plane only; they
fragment the codebase + plugin SDK), Express (legacy/slow), Next.js (SSR
unneeded locally), better-sqlite3 (native compile per arch), uWebSockets.js
(native dep + licensing quirks).
