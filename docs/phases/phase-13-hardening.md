# Phase 13 — Hardening & Performance

**Lane:** 02 (suite spans both lanes; agent-plane fixes = 01) · **Depends on:** Phases 1–8 · **Milestone:** M5

## Goal

Prove the two promises we've made since day one — **never crash the host** and
**fast, no shortcuts** — with adversarial tests and measured budgets, not
assertions. This phase turns "should" into CI gates.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Chaos suite — runtime | owner ("not crash… no shortcuts") | kill -9 llama-server mid-stream; SIGSTOP (hang) mid-generation; fill RAM externally during load; disk-full during pull; port stolen — every case must end in a typed event + recovery, host healthy |
| Chaos suite — platform | **NEW** | Kill gateway/bus/dashboard children randomly under load; supervisor restarts within budget; zero orphan processes after 1000 cycles |
| Soak test | **NEW** | 24 h: rotating model loads/unloads + a looping 2-worker team; RSS growth < set budget, no fd/port leaks (leak detector in CI-nightly) |
| Performance budgets as CI gates | **NEW** | TTFT overhead added by gateway < 15 ms p99 local; supervisor event loop lag < 50 ms p99 under 8 concurrent streams; `maya` cold boot < 1.5 s; regressions fail CI (nightly perf job, dedicated runner) |
| Streaming path audit | **NEW** | Zero-copy SSE passthrough verification — no JSON re-parse of token deltas in the hot path (the "JS never touches tokens/sec" pledge, measured) |
| Security audit — bus & gateway | **NEW** | Token scoping/revocation tests, CSWSH origin checks, admin-bearer coverage, secret-shaped-message blocking, injection-resistance of policy frames (bus specifics executed with 01) |
| Secrets hygiene sweep | **NEW** | Grep/lint gates: no `apiKeyEnv` dereferenced values in logs/errors/DB; crash bundles redacted (Phase 10 tie-in) |
| Dependency & license audit | **NEW** | `pnpm audit` gate, license allow-list (MIT-compatible), SBOM emitted with releases |
| Failure-mode documentation | **NEW** | Every typed error → a docs page with cause + operator fix; `maya doctor` links to them |
| 8 GB M1 certification run | owner (all M-series) | The full acceptance suite executed on the smallest supported machine; recommended-model list validated there |

## Deliverables

`test/chaos/*` harness (runs against real processes), nightly CI workflows
(soak, perf, security), budget config checked into repo, failure-mode docs.

## Acceptance

- Chaos suite green 50 consecutive runs on 8 GB and 16 GB machines.
- Soak passes with documented budgets; leak counters flat.
- Perf gates active in CI and at/under budget on main.
- External-style review checklist (OWASP-ish for local services) completed; findings filed + fixed or accepted with rationale.

## Risks

- Perf tests on shared/virtualized CI are noisy → dedicated Apple Silicon runner for gates; relative-regression thresholds, not absolute walls.
- Chaos tests flaking from real-process timing → generous recovery windows, deterministic fault injection points in supervisors (test hooks compiled out of release builds).
