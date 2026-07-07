# Phase 1 — Model Runtime Core

**Lane:** 02 · **Depends on:** Phase 0 · **Milestone:** M1 (with Phase 2)

## Goal

Local GGUF models that behave like appliances: pull by name, serve on demand,
survive RAM pressure and hangs — **degrade, never crash the Mac**. Node
supervises; all inference stays in `llama-server` (C++/Metal).

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| `llama-server` lifecycle | brief | Spawn per instance (own port), readiness probe, graceful stop, SIGKILL escalation |
| Health checks + hung detection | brief | `/health` polling every `healthCheckIntervalMs`; no token progress for `hungProcessTimeoutMs` → kill |
| Crash auto-restart | brief | ≤ `maxRestarts` within `restartWindowMs`, exponential backoff, then `failed` + RuntimeEvent |
| RAM guardrails | brief | Watch free RAM (`vm_stat`/`host_statistics64`); below `minFreeRamBytes`: refuse new loads, degrade or LRU-unload existing |
| Auto quant degrade | brief | Requested Q8 doesn't fit → walk the ladder (Q8_0→Q6_K→Q5_K_M→Q4_K_M…) with a `model_degraded` event, not a failure |
| Context auto-shrink | **NEW** | Second degrade axis: shrink `--ctx-size` before refusing entirely |
| GGUF pull from HuggingFace | brief | `hf:<repo>[/<file>]` resolution, resumable download, progress via SSE `pull_progress` |
| Checksum + disk-space preflight | **NEW** | SHA256 verify after pull; refuse to start a pull that would blow the disk |
| Model registry | brief | `LocalModel` index of installed GGUFs (multi-quant per model) in `~/.maya/models` |
| Model profiles | brief | Per-model overrides: quant, context, guardrail knobs — persisted (`model_profiles` table) |
| RAM-tier recommendations | **NEW** | "Will this fit?" estimator (weights+KV vs free RAM) + suggested models per 8/16/32/64 GB tier — all M-series is the target |
| Metal tuning defaults | brief | `-ngl 999`, mmap on, flash-attn when supported; per-chip sane defaults |
| Token/sec + RSS sampling | **NEW** | Rolling perf samples per instance (`runtime_samples` table) — feeds dashboard + Phase 11 benchmark |
| Idle LRU unload | **NEW** | Instances idle > `autoUnloadLruAfterSec` are unloaded to reclaim RAM |
| Structured instance logs | **NEW** | Ring buffer + `~/.maya/logs/<instance>.log` rotation |
| llama.cpp presence doctor | **NEW** | Detect `llama-server` (brew/custom path), version check, install hint — first-run UX depends on it |

## Deliverables

`@maya-ai/model-runtime`: `RuntimeManager` (load/unload/list/status),
`Downloader` (pull jobs), `RamWatcher`, `InstanceSupervisor`,
emitting `RuntimeEvent`s; unit tests with a fake backend + one real
llama.cpp integration test behind an env flag.

## Acceptance

- Pull a real model (e.g. `hf:Qwen/Qwen3-4B-GGUF`) with live progress; checksum verified.
- Serve it; kill -9 the llama-server → auto-restart ≤3 attempts with events.
- Simulate RAM pressure (env override of free-RAM reading) → load degrades Q8→Q4, `model_degraded` emitted, **host never swaps to death**.
- Request a model that can't fit even at Q3/min-context → clean `failed` with a human-readable reason, machine stays healthy.
- Hung server (SIGSTOP the child in a test) → killed + restarted within policy.

## Risks

- llama.cpp flag churn between releases → pin a tested version range in doctor; CI matrix later (Phase 13).
- Free-RAM heuristics on macOS are subtle (compressed memory) → use available = free+inactive+purgeable, validated on 8 & 16 GB machines.
- Big pulls on flaky Wi-Fi → resumable ranges + retry with backoff.
