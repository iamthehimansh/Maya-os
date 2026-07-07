# Phase 3 — Maya Bus (lane 01)

**Goal:** Maya's own agent message bus — a walkie-talkie-style protocol,
implemented fresh in this repo (MIT). `~/work/colate/cana-web` is a READ-ONLY
reference (owner directive 2026-07-08): protocol ideas may be studied, code is
never copied or edited.

**Demo:** `maya bus` starts the server; two terminal clients join a channel
with scoped tokens, exchange broadcast + private messages, and replay history
after a reconnect.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| WS bus server | brief | `packages/bus` on `ws`; channels; strictly-increasing per-channel `seq`; broadcast / directed / private messages |
| Token auth | brief | per-agent `wtk`-style tokens via env (`MAYA_BUS_TOKEN`) sent in the WS subprotocol — never in URLs or argv |
| Capabilities & roles | **NEW** | `receive/send/act/admin` per token; server stamps `fromRole` on every frame — clients can never forge identity or role |
| Channel policy | **NEW** | server-delivered policy frames + client ack; policy is data only the server can send (anti-injection by construction) |
| History | brief | SQLite-backed per-channel history; sent as one `history` frame on (re)join with context-only semantics; retention config |
| Work-status | **NEW** | working/paused/done presence frames with TTL — powers the dashboard's "who is doing what" live view |
| Loop payloads | brief | `body.maya` envelope carries loop protocol v1 (phase 7); zod validation generated from `packages/core` contracts |
| Channel conventions | brief | `maya/team/<id>` long-lived rooms; `maya/task/<id>` ephemeral rooms the Loop lead opens/closes |
| Client SDK | **NEW** | `@maya-ai/bus-client`: auto-reconnect w/ backoff + jitter, outbound queue (sends never lost across reconnects), seq dedupe, typed frames |
| REST admin API | **NEW** | mint/revoke tokens, list channels/participants, paginated history — consumed by orchestrator + dashboard |
| Message cancel | **NEW** | sender retracts a message; working agents are signalled to stop in-flight work for that seq |

## Deliverables

- `packages/bus` (server) + `packages/bus-client` (SDK), both typed against `packages/core/src/contracts/bus.ts`
- `maya bus` subcommand (standalone) + supervisor integration (phase 5 boot)
- Protocol doc: `docs/bus-protocol.md` (frames, auth, ordering, privacy rules)

## Acceptance criteria

1. 50 concurrent local clients: no dropped or re-ordered messages (seq audit passes).
2. Kill the server mid-traffic → clients reconnect, queued outbound flushes in order, no duplicates.
3. A `member`-role token cannot send `act`-gated frames; a forged role in text changes nothing (server stamp wins).
4. Private messages never appear in any other participant's stream or history read.
5. History replay after rejoin is byte-identical to live receipt (context-only flag set).

## Risks

| Risk | Mitigation |
|------|-----------|
| Protocol scope creep (rebuilding all of Cana) | v1 = exactly the frames in `contracts/bus.ts`; everything else is phase 12+ plugin territory |
| Reinventing subtle bugs the reference already solved | study cana-web behavior (read-only) for edge cases: reconnect races, privacy stickiness, seq gaps |
| SQLite write contention with chatty agents | WAL mode + single-writer queue; benchmark in acceptance |
