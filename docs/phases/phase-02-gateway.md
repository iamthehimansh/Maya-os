# Phase 2 — Gateway

**Lane:** 02 · **Depends on:** Phase 1 · **Milestone:** M1 (with Phase 1)

## Goal

One port (default **4100**), every model. Anything that speaks OpenAI or
Anthropic HTTP — including every coding agent we'll ever adapt — talks to
`localhost:4100` and never knows (or cares) whether a local llama-server or a
cloud provider answered.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| OpenAI-compatible `/v1/chat/completions` | brief | Streaming (SSE) + non-streaming; routed by `ModelId` prefix |
| OpenAI-compatible `GET /v1/models` | brief | Catalog = enabled cloud models + installed local GGUFs |
| Anthropic-compatible `POST /v1/messages` | brief | Claude Code points `ANTHROPIC_BASE_URL` here → runs on ANY model, incl. local GGUF (bidirectional translation: system, tools, streaming events) |
| Cloud providers: OpenAI, Anthropic, Gemini, Groq, Together, DeepSeek, NVIDIA | brief | Per-provider translation adapters; keys via env refs (`apiKeyEnv`) — never stored in config |
| On-demand local model start | **NEW** | Request for a stopped `local/*` model → runtime loads it (within guardrails), request waits with keep-alive, then streams — Ollama-style UX |
| Control API (`/api/*`, admin bearer) | brief | models list/pull/load/unload, runtime health, SSE `RuntimeEvent` stream (contract in `models.ts`) |
| Model aliases | **NEW** | `maya/fast`, `maya/best`, user-defined → concrete `ModelId`; lets teams say "the fast model" and re-point centrally |
| Usage metering | **NEW** | Per model + per caller (agent id header) token counts → `runtime_samples`/usage tables; feeds cost view (cloud pricing table) and Loop budget enforcement (Phase 7) |
| Timeouts, retries, circuit breaker | **NEW** | Per-provider policies; a dead cloud provider degrades that provider only, never the gateway |
| Request logging with privacy switch | **NEW** | Metadata always; prompt/response capture is OFF by default, per-project opt-in — local-first means private-first |
| Rate limiting | **NEW** | Per-caller token bucket; protects an 8 GB machine from a runaway agent loop |
| CORS for dashboard | **NEW** | Localhost-origin allow-list only |

## Deliverables

`@maya-ai/gateway` (Hono + undici): router, provider adapters,
OpenAI↔Anthropic translators, control API, SSE event fan-out; contract tests
that replay recorded provider fixtures + a live smoke test behind env flags.

## Acceptance

- `curl localhost:4100/v1/chat/completions -d '{"model":"local/<pulled>",…}'` streams tokens from llama-server.
- Same call with `"model":"anthropic/claude-sonnet-5"` (key configured) round-trips a cloud provider.
- Claude Code with `ANTHROPIC_BASE_URL=http://localhost:4100` completes a real coding turn on a **local** model.
- Stopped local model → first request auto-loads it (guardrails respected) and answers.
- `GET /v1/models` lists both worlds; `/api/events` streams a `model_degraded` when Phase 1's degrade test runs.
- Kill the network → cloud calls fail fast with typed errors; local models unaffected.

## Risks

- Anthropic⇄OpenAI translation fidelity (tools, streaming deltas, stop reasons) — the Claude Code acceptance test is the bar; keep a fixture corpus.
- Provider API drift → adapters are small, fixture-tested, and versioned.
- Metering accuracy for streamed responses → count from usage frames where providers send them, tokenizer estimate otherwise (flagged as estimate).
