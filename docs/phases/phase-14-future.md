# Phase 14 — Distributed & Future (lane 01 lead; exploratory)

**Goal:** Maya beyond one Mac and beyond coding-agent basics: distributed
execution, memory/knowledge, and the ecosystem. Each track ships independently
behind its own flag — nothing here blocks v1.

## Track A — Distributed Maya

| Feature | Source | Detail |
|---------|--------|--------|
| Multi-Mac workers | brief | discover/pair Macs on LAN (Bonjour); remote model instances + remote agent spawn over the bus; one dashboard for the fleet |
| Remote GPU workers | brief | attach a Linux/GPU box as a runtime backend (vLLM there; same gateway ModelIds — nothing above the gateway changes) |
| Cloud burst | brief | overflow team members to cloud models automatically under phase-6 budget rules |
| Fleet health | **NEW** | per-node capacity/health in scheduler decisions; graceful node loss = tasks reassigned, not lost |

## Track B — Memory & knowledge

| Feature | Source | Detail |
|---------|--------|--------|
| RAG service | brief | local embeddings index (sqlite-vec) over project docs/code; exposed as a tool to every agent via the gateway |
| Shared team memory | **NEW** | decisions/conventions store the Loop lead reads+writes across runs (why we chose X lives with the project) |
| Knowledge graph | brief | entities (services, APIs, owners) extracted from repos; agent-queryable |
| Conversation recall | **NEW** | search across all past runs/channels with artifact links (builds on phase-9 persistence + phase-8 replay) |

## Track C — Frontier

| Feature | Source | Detail |
|---------|--------|--------|
| Fine-tuning jobs | brief | LoRA fine-tunes on-Mac (MLX) with datasets curated from team memory + run journals |
| Voice | brief | talk to the Loop lead: local STT/TTS, push-to-talk in dashboard/TUI |
| Mobile monitoring | brief | PWA: approvals inbox, progress, kill switch — the phase-8 approvals surface, pocket-sized |
| Self-improving workflows | brief | lead mines run journals for better decomposition/verification strategies; proposals gated behind owner approval |
| Marketplace | brief | community hub for agents, topologies, plugins, model profiles — phase-12 signing + metadata made public |

## Sequencing & acceptance

- Order of attack: **B (RAG/memory) → A (distributed) → C (frontier)** — memory
  multiplies the Loop Agent's value on day one; distribution multiplies capacity.
- Each track gets its own detailed doc + acceptance criteria when scheduled;
  the bar stays the platform bar: never crash the host, degrade before refusing.

## Risks

| Risk | Mitigation |
|------|-----------|
| Future work distracts from the 4-week core | this phase is explicitly post-M5; no code lands before phase 13 exits |
| Distributed failure modes explode complexity | reuse the bus + task-engine semantics (accept/reassign) — no new coordination primitives |
| Memory features leak private code into indexes | local-only by default; per-project opt-in; index encrypted at rest |
