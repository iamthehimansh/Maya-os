# Phase 4 — Agent Runtime (lane 01)

**Goal:** spawn and control real coding agents (Claude Code, Codex, OpenCode)
programmatically, on ANY configured model via the gateway, wired to the bus.

**Demo:** `maya agent spawn claude-code --model local/qwen3-14b --cwd ~/proj`
opens a live Claude Code session running against a local GGUF; `maya agent
logs/pause/resume/kill` all work; the agent appears on its team channel.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Adapter framework | brief | `AgentAdapter` registry keyed by `AdapterId`; contract in `packages/core/src/contracts/agents.ts` |
| Preflight `detect()` | **NEW** | is the CLI installed? version? auth state? returns install hint for onboarding (phase 5 wizard) |
| PTY supervision | brief | node-pty spawn; ANSI-clean log capture; stdin injection (`send`); SIGSTOP/SIGCONT pause/resume; graceful→forced kill |
| Claude Code adapter | brief | auth modes from the `cldzz` pattern (API key / OAuth / gateway); `ANTHROPIC_BASE_URL` → gateway Anthropic-compat, so it runs on any ModelId incl. local GGUF |
| Codex adapter | brief | same surface over the Codex CLI |
| OpenCode adapter | brief | same surface over the OpenCode CLI |
| Structured events | **NEW** | adapters parse raw output into `AgentEvent`s: state changes, questions (agent blocked on input), artifacts, token counts, errors |
| Permission modes | **NEW** | `ask` (tool prompts on) vs `auto` (adapter's skip-permissions flag) per spawn — Loop workers run `auto`, human-attended sessions `ask` |
| Bus auto-join | brief | every spawned agent gets a least-capability token minted (phase 3 REST) and joins its team/task channel; questions surface on-channel |
| Workspace management | **NEW** | per-agent cwd; git-worktree option so parallel agents share one repo without collisions |
| Agent registry | **NEW** | live agents persisted in SQLite; on supervisor restart: re-attach to live PIDs or mark orphaned + clean up |

## Deliverables

- `packages/agent-runtime`: framework + 3 adapters, event parsers, registry
- `maya agent spawn/list/logs/pause/resume/kill/send` CLI
- Adapter-author guide (`docs/adapters.md`) — the phase-12 plugin SDK builds on it

## Acceptance criteria

1. Claude Code spawned on `local/…` completes a real edit task end-to-end with zero cloud calls (gateway logs prove it).
2. `pause` freezes CPU to ~0 within 1s; `resume` continues the session losslessly.
3. Kill mid-task leaves no zombie process, no orphaned PTY, registry consistent.
4. A `waiting_input` agent's question reaches the bus within 500ms with the question text.
5. All three adapters pass one shared conformance test suite (spawn→event stream→send→exit).

## Risks

| Risk | Mitigation |
|------|-----------|
| Agent CLI output formats change between versions | version-pinned parsers + `detect()` gates; conformance suite runs in CI against pinned versions |
| node-pty native builds across M1→M4 / Node versions | prebuilds verified in CI matrix; it stays our ONLY native dep |
| PTY buffering swallowing interactive prompts | adapter-level heartbeat + `waiting_input` detection tested per tool |
