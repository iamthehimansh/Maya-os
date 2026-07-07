# Phase 6 — Teams & Orchestrator (lane 01)

**Goal:** compose agents into teams with explicit topologies, a task state
machine, and hard budgets. This is the layer the Loop Agent (phase 7) drives.

**Demo:** `maya team create dev --agents claude-code:2,codex:1 --model
local/qwen3-14b` creates a team wired into one bus room; tasks flow through the
board; killing a worker reassigns its task.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Team model | brief | teams/members in SQLite (core schema); each team gets a `maya/team/<id>` room + task board |
| Topologies | brief | manager-tree, round-robin, parallel, sequential, **voting**, **debate** — a pluggable `Topology` strategy interface (phase-12 plugin point) |
| Task engine | brief | task graph with deps; states `queued → assigned → accepted → working → blocked/done/failed`; loop-protocol driven transitions |
| Crash-safe delegation | **NEW** | `task_accept` claim semantics: unaccepted tasks are reassignable; worker death → automatic reassignment with salvage of partial artifacts |
| Budgets | **NEW** | per-team token/$ caps metered at the gateway per ModelId; soft-warn at 80%, hard-stop + owner notification at 100% |
| RAM-aware scheduling | **NEW** | orchestrator reads gateway `/api/runtime/health` before spawning local-model agents; refuses placements that would breach guardrails |
| Mixed fleets | brief | any member on any ModelId — local + cloud in one team |
| Team lifecycle | **NEW** | create/scale/drain/kill; drain = finish accepted tasks, accept nothing new |
| Audit trail | **NEW** | every assignment/transition/budget event persisted — powers Tasks timeline (phase 8) |

## Deliverables

- `packages/orchestrator`: team manager, topology strategies, task engine, budget meter
- `maya team create/list/status/scale/drain/kill` + `maya task add/assign/list`
- Topology-author doc (strategy interface)

## Acceptance criteria

1. Round-robin and manager-tree topologies pass the same task-set conformance test with identical results.
2. `kill -9` a worker mid-task → task reassigned within 10s; no task lost or duplicated (audit trail proves exactly-once completion).
3. Budget hard-stop halts new gateway calls within 1 request; owner notified on the team room.
4. Scheduler never spawns a local-model agent that would push free RAM below the guardrail floor (chaos-tested with a RAM hog).
5. 3-team / 9-agent load: task board stays consistent under concurrent transitions.

## Risks

| Risk | Mitigation |
|------|-----------|
| Distributed-state bugs (double assignment) | single-writer task engine; all transitions through one SQLite transaction path |
| Budget metering drift vs provider billing | meter on gateway-observed tokens; reconcile daily against provider usage APIs where available |
| Topology combinatorics ballooning tests | one shared conformance suite parameterized by topology |
