# Agent walkie-talkie I/O (himansh's proactive-agent vision)

Make every spawned agent work like the **walkie-talkie client** (`02` runs this exact
loop): a persistent presence that **monitors an inbox file for incoming** channel
messages and **writes an outbox file to send** — the bridge posts each outbox line to
the channel on the agent's behalf. No "schedule" tool; the agent *just runs* and writes
whenever it wants (5 hellos over 5s = 5 outbox lines with `sleep 5` between; proactive
ping = write an outbox line any time).

Reference: `~/.claude/commands/walkie-talkie.md` (the client `02` is running) — same
`in.jsonl` / `out.jsonl` / Monitor shape, scoped per agent.

## Two files per agent (bridge owns the paths)

On spawn, the bridge creates a per-agent dir and passes both paths as env:

```
MAYA_AGENT_INBOX  = ~/.maya/agents/<agentId>/in.jsonl     # bridge → agent (incoming)
MAYA_AGENT_OUTBOX = ~/.maya/agents/<agentId>/out.jsonl    # agent → bridge (outgoing)
```

Touch both to empty files at spawn so the agent can read/append immediately.

## Inbox — bridge writes incoming, agent reads

Every channel message the agent should see, the bridge **appends as one JSON line** to
`MAYA_AGENT_INBOX` (skip the agent's OWN messages to avoid a loop):

```json
{"seq":42,"from":"@himansh","ts":"2026-07-08T21:10:00Z","text":"hello?","to":"@bob"}
```

- Append the SAME messages the current wake-on-@tag path feeds — plus, if himansh wants
  "always wake", every human message (not just @mentions).
- The agent monitors it with its own tools: `tail -f "$MAYA_AGENT_INBOX"` in a Bash step,
  or re-reads on each wake. Track the highest `seq` handled (footgun: don't reprocess).

## Outbox — agent writes, bridge posts (the key piece)

The agent **appends a line to `MAYA_AGENT_OUTBOX` whenever it wants to say something**.
The bridge **watches the file and posts each NEW line** to the channel via
`manager.sendMessage` / `postMessage`:

- **Plain text line** → broadcast to the channel (everyone/human sees it).
- **JSON line** `{"text":"…","to":"@handle"}` → directed at a handle.

Watcher rules (the at-least-once + dedup discipline from the walkie-talkie client):
1. Track a **byte offset** (or line count) already posted; on each fs-watch/1s-poll, read
   only bytes past the offset, split on `\n`, post each COMPLETE line, advance the offset.
2. **Never post a partial line** — if the tail has no trailing `\n`, wait (a write in
   progress). Only post up to the last newline.
3. **Advance offset only after a successful post** (at-least-once; a failed post retries
   next tick). The bus client already dedups on (channel, token, cid) if you stamp a cid.
4. On **team drain / agent stop**, stop the watcher + remove the per-agent dir.

## Agent systemPrompt (tell it the loop)

> You are a persistent agent on a shared channel. **Incoming:** new messages appear as
> JSON lines in the file at `$MAYA_AGENT_INBOX` — watch it (`tail -f`) and act on lines
> addressed to you. **Outgoing:** to say anything on the channel, **append a line to
> `$MAYA_AGENT_OUTBOX`** (plain text, or `{"text":"…","to":"@who"}` to direct it) — it is
> posted for you. You may write multiple lines over time (e.g. sleep between them) and
> message on your own initiative. Keep running; don't exit.

## Why files (not the MCP schedule)

himansh: the schedule tool is a hack. Files are the real thing — the agent posts N
messages, timed or proactive, using only its native Bash/Read/Write tools + two files,
exactly like the walkie-talkie client. `send_message` (MCP) stays as a convenience for a
one-shot post, but the OUTBOX FILE is the mechanism.

## Split

- **02 (this doc + the format/footguns):** reference impl is the walkie-talkie client `02`
  runs; happy to review the watcher.
- **01 (bridge/adapter):** create the per-agent files + env, write incoming→inbox, watch
  outbox→postMessage (offset/at-least-once as above), keep the agent process alive, add the
  systemPrompt. Graceful-degrade if the dir can't be made (agent still runs, just no I/O
  files) — never crash the spawn.
