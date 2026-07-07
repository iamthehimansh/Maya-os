# Phase 5 — CLI & TUI

**Lane:** 02 · **Depends on:** Phases 1, 2 · **Milestone:** M2 (with 3, 4)

## Goal

`npx maya-os` is the whole product for a terminal user: boot everything,
manage models and agents, watch a team work — a real TUI (owner preference:
**Node for the TUI**), instant and discoverable.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Boot supervisor (`maya`) | brief | Starts gateway + bus + dashboard server as supervised children; one Ctrl-C tears all down cleanly; `maya --headless` for daemon use |
| Ink TUI shell | owner | React-for-terminal: panes for Models (RAM/tok/s live), Agents, Teams, event feed; keyboard nav |
| First-run onboarding wizard | **NEW** | Detect chip + RAM tier → recommend a starter GGUF → pull with progress → detect/install-hint coding agents (Claude Code/Codex/OpenCode) → optional cloud keys (env refs) → "you're ready" |
| `maya models` subcommands | brief | `pull` `ls` `run` `stop` `rm` `info` — Ollama-familiar verbs over the control API |
| `maya agents` subcommands | brief | `spawn --adapter claude-code --model local/…` `ls` `logs -f` `pause` `resume` `kill` |
| `maya teams` / `maya loop` | brief | Create team from a template, assign a task, follow the loop live (thin client over orchestrator API) |
| `maya doctor` | **NEW** | Checks: node version, llama-server presence/version, RAM tier, ports free, agent CLIs installed, keychain/env keys visible — with fix hints |
| `maya config` | **NEW** | Get/set config keys, enable providers, edit guardrails — validated against contracts |
| Shell completions | **NEW** | zsh/bash/fish generated from the command tree |
| Machine-readable output | **NEW** | `--json` on every read command — scripting + tests use the same surface humans see |

## Deliverables

`apps/cli` grows: `commander` command tree, Ink app, supervisor (process
group management, port-conflict detection, crash restart of children),
onboarding flow; e2e tests driving the CLI with a PTY.

## Acceptance

- On a clean Mac (llama.cpp present): `npx maya-os` → wizard → starter model pulled → TUI shows it serving — **under 2 minutes** after download completes.
- `maya models run local/<m>` then `maya agents spawn --adapter claude-code --model local/<m>` works end-to-end (M2 bar, with Phases 3–4).
- Kill the gateway child process → supervisor restarts it; TUI shows the blip; no orphan llama-servers after `maya` exits (process-group kill verified).
- `maya doctor` on a machine with nothing installed produces an actionable checklist.

## Risks

- PTY/TUI testing is finicky → keep the TUI a thin view over the same APIs `--json` uses; test logic below the view.
- Supervisor orphan processes → POSIX process groups + `pdeathsig`-equivalent watchdog polling; acceptance test covers it.
