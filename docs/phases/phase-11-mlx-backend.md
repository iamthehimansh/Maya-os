# Phase 11 — MLX Backend

**Lane:** 02 · **Depends on:** Phase 1 · **Milestone:** M5

## Goal

Make "faster than bare llama.cpp on Apple Silicon" real where it's actually
winnable: a second, Apple-native backend (**MLX**) behind the same
`RuntimeBackend` seam, with honest per-model benchmarks choosing the backend —
not vibes.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| MLX server adapter | brief ("vLLM-like", MLX phase 2) | Supervise `mlx_lm.server` (OpenAI-compat) exactly like llama-server: health, hung-kill, restart, RAM guardrails — same `InstanceSupervisor` contract |
| MLX model management | **NEW** | Pull/convert MLX community models (or `mlx_lm.convert` from HF) into the same registry; `LocalModel` grows a format axis (gguf/mlx) |
| Benchmark harness | **NEW** | `maya models bench <id>`: prompt-processing + generation tok/s, TTFT, peak RSS, per backend/quant on THIS machine; results into `runtime_samples` |
| Auto backend selection | **NEW** | Per-model default backend = benchmark winner on this chip/RAM tier; user-overridable per profile |
| Python runtime isolation | **NEW** | MLX is Python — dedicated venv under `~/.maya/runtimes/mlx`, provisioned by doctor with consent, never touching system Python |
| Speculative decoding (exploration) | brief ("future") | Draft-model speculation via llama.cpp's native support; benchmark harness decides where it pays off — gated experiment, not a promise |
| Guardrail parity | brief | Degrade axes for MLX (quant variants, context) mapped so the never-crash policy holds across backends |

## Deliverables

`@maya-ai/model-runtime` additions: `backends/mlx.ts`, format-aware registry +
pulls, bench command + report format; docs comparing backends per RAM tier
(published numbers, reproducible via the bench command).

## Acceptance

- Same `ModelId` family servable via either backend; gateway callers can't tell (contract test).
- `maya models bench` produces a table for ≥2 models on the dev machine; auto-selection picks the measured winner and records why.
- MLX process misbehavior (hang/crash/RAM spike) hits the same guardrails as llama.cpp — chaos tests from Phase 13 run against both backends.
- A Mac without the MLX venv still works fully (llama.cpp-only) — MLX is additive, doctor-provisioned.

## Risks

- MLX API/server maturity churn → adapter kept thin; version-pinned venv; llama.cpp remains the default until bench + stability clear a bar.
- Python venv weight (~GBs with deps) → strictly opt-in via doctor; uninstall path removes it.
- Benchmark honesty (thermal state, background load skew results) → bench runs report machine state and require repeat-run agreement before flipping defaults.
