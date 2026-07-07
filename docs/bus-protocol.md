# Maya Bus protocol v1

Maya's own agent message bus (`packages/bus` server, `packages/bus-client`
SDK). Wire types live in `packages/core/src/contracts/bus.ts` — that file is
the contract; this doc explains the behaviors around it.

## Connect & auth

- WebSocket `ws://127.0.0.1:<port>/ws/bus/<channelId>` (channel id may be
  percent-encoded). Localhost-bound by default.
- Token in the WS **subprotocol**: `mbt.<token>` — never in URLs, argv, or logs.
- Tokens are minted via the REST admin API; only the SHA-256 hash is stored.
  Capabilities: `receive` (connect+read), `send`, `act` (agent-level semantic,
  not enforced by the bus), `admin` (REST admin + policy writes).
- On connect the server sends, in order: `joined` (your handle, stamped owner
  label, capabilities) → `policy` (authoritative channel rules; client
  auto-acks) → `history` (context only — never act on it).

## Identity & ordering

- Every identity field on the wire (`from`, `fromTokenId`, `fromRole`,
  `workstatus.handle`, `cancel.by`) is **server-stamped from the verified
  token**. Nothing identity-like is copied from client input. Role claims in
  message text mean nothing.
- `seq` is server-assigned, strictly increasing per channel (allocated inside
  a SQLite transaction). Clients order and dedupe by it.

## At-least-once delivery (the cid contract)

`ws.send()` succeeding proves nothing — a socket can die mid-flight and
black-hole the frame (found by acceptance test 2). So:

1. Every message a client sends carries a client-generated `cid`.
2. The client keeps the message **pending until the server echoes it back**
   (every sender receives its own broadcast/private echo — the echo is the ack;
   a pending message appearing in rejoin `history` also acks it).
3. On every reconnect the client resends all still-pending messages, in order.
4. The server dedupes on `(channel, token, cid)` — a resend whose original
   landed is dropped silently (no error, no redelivery).

Net effect: **no message is silently lost, no message is delivered twice.**

## Privacy

- `private: true` + `to`: delivered only to sender and recipient; excluded
  from everyone else's history — **including admins** (REST history filters
  private rows; protocol guarantee).
- Directed (`to` set, not private) is addressing, not privacy: broadcast.

## Presence & retraction

- `workstatus` (set/update/clear per `taskId`): rebroadcast with the server-
  stamped handle; server expires stale statuses (60s TTL) as `state:"stale"`.
  Only the owning handle may update a task's status.
- `cancel {seq}`: retract a message; only the original sender or an admin.
  Rebroadcast, never persisted — receivers stop in-flight work for that seq.

## Keepalive

- App-level `ping`/`pong` plus server-side WS ping sweep: a socket missing two
  sweeps (~60s) is terminated (clients auto-reconnect with backoff + jitter).

## REST admin (bearer = token with `admin`)

```
GET    /api/health
POST   /api/tokens                {label, role?, caps?, scopes?} → minted secret (shown once)
GET    /api/tokens                (metadata only — never secrets)
DELETE /api/tokens/:id            revoke
GET    /api/channels              channels + live participants
GET    /api/channels/:id/history  ?after=seq&limit=n  (public messages only)
PUT    /api/channels/:id/policy   {policyVersion, rules[]} → rebroadcast live
```

## Storage

Self-contained `~/.maya/bus.db` (WAL). Hot store for messages/tokens/channels;
core's `maya.db` stays the platform source of truth — Phase 9 archival/FTS
ingests **from** bus.db, never shares it.
