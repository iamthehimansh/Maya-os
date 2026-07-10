# Maya — a local-first AI OS for developers

One command boots a **model gateway**, an **agent orchestrator**, a **message bus**, and a **web dashboard** on your Mac. Run local GGUF models with RAM guardrails, drive real Claude Code agents (cloud or local), watch each agent's **actual terminal live**, and let agents message you **proactively** — no polling, no schedule hacks.

```bash
npm install -g maya-os     # or: npx maya-os serve
maya serve                 # gateway :4100 · dashboard :4200 · bus :4300 · orchestrator :4400
```

Open **http://127.0.0.1:4200** → Chat.

## What you get

- **Chat with agent teams** — create a team (lead + members, each fully configured: model, working directory, tools, auth profile), talk to it in the dashboard, `@mention` an agent to wake it.
- **Real terminals** 🖥️ — every standing agent runs interactive Claude Code in a **real PTY** (not `--print`). Click the terminal icon on any agent to watch the actual TUI work, live.
- **Proactive agents** — each agent gets an inbox + outbox file; anything it appends to its outbox posts to the chat as that agent, on its own initiative. `curl` your agent's server and watch it say hello in your chat.
- **Local models with guardrails** — pull GGUFs (`maya models pull hf:...`), served via llama.cpp with RAM-floor monitoring, auto quant-downgrade, hung-process restarts. `maya tune <model>` benchmarks quant×context for your machine.
- **One gateway for every model** — OpenAI-compatible `/v1/chat/completions` + Anthropic-compatible `/v1/messages`; point any coding agent at `ANTHROPIC_BASE_URL=http://127.0.0.1:4100` and it runs on whatever model you route.
- **The Loop** — a persistent lead plans, spawns workers, **verifies against the real files**, and reports honestly (it will not claim success it can't verify).
- **Teams survive restarts** — standing teams re-hydrate on boot; nothing is lost on upgrade.

## Requirements

- macOS (Apple Silicon) — other platforms untested
- Node ≥ 22.5
- For local models: `brew install llama.cpp`
- For agents: the `claude` CLI (`npm i -g @anthropic-ai/claude-code`)
- Optional: `maya doctor --install-switchyard` provisions the Anthropic⇄OpenAI translation sidecar

## Commands

| command | what it does |
|---|---|
| `maya serve` | boot everything (Ctrl-C to stop; teams survive) |
| `maya status` | what's running |
| `maya models pull/ls/run` | manage local GGUFs |
| `maya tune <model>` | find the fastest quant×context for your RAM |
| `maya team create/list/drain` | standing agent teams |
| `maya loop "<goal>"` | run a verified multi-agent loop |
| `maya doctor` | environment checks |

## Security notes

- Everything binds `127.0.0.1`. The admin API (`/api/*`) refuses proxied/tunneled requests — a tunnel can only ever expose the inference surface (`/v1/*`).
- Auth profiles are read server-side from `~/.cldz/config.json`; credentials never reach the browser and never leave your machine.
- Config stores env-var *names*, never keys.

MIT © himansh
