# Phase 8 — Dashboard (lane: split — 02 Models tab, 01 the rest)

**Goal:** the browser window into the whole system, live. React + Vite +
Tailwind SPA served statically by the supervisor — no SSR server; all data over
bus WS + gateway SSE, no polling.

**Demo:** `maya` (boot) → `localhost:4200` shows models serving, agents
working, the team graph, the task board, and every conversation — all updating
live while a loop run executes.

## Features

| Feature | Source | Lane | Detail |
|---------|--------|------|--------|
| Models tab | brief | 02 | catalog + pull progress, live instances (state/quant/context), RAM + tokens/sec charts (uPlot), load/unload controls, degrade-event feed |
| Agents tab | brief | 01 | live agent list w/ state badges, streaming logs (ANSI-rendered), pause/resume/kill, spawn form (adapter/model/cwd/permission mode), token usage per agent |
| Teams tab | brief | 01 | topology graph visualization (live member states on the graph), budget burn-down, scale/drain controls |
| Tasks | brief | 01 | kanban by state + timeline view of the task graph; artifacts per task (file/diff/report previews) |
| Conversations | brief | 01 | bus room viewer (history + live), private-thread separation, message search; **question surfaces with clickable option buttons** feeding loop `answer`s |
| Approvals inbox | **NEW** | 01 | one place for everything awaiting the human: loop questions, budget overrides, destructive-action confirms |
| Run replay | **NEW** | 01 | scrub through a finished loop run: tasks, messages, artifacts on one timeline (reads phase-9 persistence) |
| Onboarding wizard | **NEW** | 02 | first-run: install agents (via `detect()` hints), pull a starter model sized to this Mac's RAM, add provider keys |
| Theme + a11y | **NEW** | 01 | light/dark, keyboard-first navigation, WCAG AA contrast |

## Deliverables

- `apps/dashboard` (Vite SPA) + typed API client generated from contracts
- Supervisor static serving + auth (local token so other LAN users can't drive your agents)
- Component library kept minimal: Tailwind + headless primitives, uPlot charts

## Acceptance criteria

1. Full M3 loop demo watchable live: every state change visible < 1s after the bus/SSE event.
2. Dashboard cold load < 1s on localhost; bundle < 500KB gzipped (no SSR, no heavy chart libs).
3. Answering a loop question from the Conversations tab unblocks the worker (round-trip proven).
4. Kill the gateway → Models tab shows degraded state + reconnects automatically when it returns; no white-screen.
5. Two browsers open simultaneously stay consistent (single source of truth = bus/SSE, no client-side divergence).

## Risks

| Risk | Mitigation |
|------|-----------|
| Split-lane UI drifts into two styles | shared component kit + tokens defined before tabs are built; PR review across lanes |
| Live-stream firehose renders janky | virtualized lists everywhere; uPlot for time-series; event coalescing (200ms frames) |
| Local-only auth assumptions leak to LAN | bind to localhost by default; explicit `--host` opt-in with token auth |
