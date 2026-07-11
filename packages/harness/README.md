# @maya-os/code — **maya code** (`mayac`)

The coding agent of **[Maya OS](https://www.npmjs.com/package/maya-os)** — a
local-first AI operating system for developers. `mayac` is a provider-agnostic
coding-agent harness built fresh on the official **Anthropic** and **OpenAI**
SDKs, with a full-screen **Ink** TUI and a CLI. One internal message+tool format;
adding a third provider is a single new file. It runs on **your own subscription
or API key**, and inside Maya OS it's a selectable agent runtime alongside Claude
Code and Codex.

## Install

```bash
npm install -g @maya-os/code      # then run:  mayac
# or, no install:
npx @maya-os/code                 # interactive TUI
npx @maya-os/code -p "add a /health route and run the tests"
```

## Highlights

- **Two providers, one interface.** `Provider.stream(req) → AsyncIterable<StreamEvent>`.
  Anthropic Messages API and OpenAI Responses API both translate to the same
  internal `ModelMessage` / tool format.
- **API key _and_ subscription auth, per provider, auto-detected.**
  - Anthropic: `ANTHROPIC_API_KEY`, or Claude Code OAuth (`~/.claude/.credentials.json`
    / macOS keychain `Claude Code-credentials`).
  - OpenAI: `OPENAI_API_KEY`, or ChatGPT/Codex login (`~/.codex/auth.json`) which
    targets the ChatGPT/Codex backend.
- **Real agent loop.** Streaming, tool-use turn loop, context auto-compaction near
  the token limit, retry/backoff, and token+cost accounting.
- **Tools with a permission gate.** `read`, `write`, `edit` (exact-string replace),
  `bash`, `glob`, `grep`, `ls`. Reads auto-allow; writes/bash are gated unless
  `--yolo`.
- **Full-screen Ink TUI** (Claude-Code-like). A fixed layout — status header, a
  managed scroll viewport, and a live input box:
  - **Scrollback viewport.** PageUp/PageDown + auto-stick to the bottom; a
    `▼ N new below` hint when you've scrolled up.
  - **Collapsible tool calls.** The most recent call shows full detail; older
    ones collapse to one line. `Ctrl+P`/`Ctrl+N` focus a call, `→`/Enter expand,
    `←` collapse.
  - **Autocomplete.** Slash commands, `@`/path files (from the cwd), and command
    history — Tab accepts, Esc dismisses, ↑/↓ moves.
  - **Send while working.** Type mid-turn to **queue** the next message (shown as
    a chip); **Esc interrupts** the running turn (aborts the stream + any running
    tool).
  - **Dynamic `/model` list** fetched from the provider's `/v1/models` (cached,
    falls back to a built-in list offline).
  - **Background tasks.** `/bg <cmd>` runs a detached shell command; `/tasks`
    lists/kills them; a `⚙ N bg` chip shows in the header.
  - **Sessions.** Every session persists to `~/.maya-harness`; `/resume` (or
    `--resume`/`--continue`) reloads a past transcript. ↑/↓ walks input history.

## Build from source

```bash
pnpm -C packages/harness build
pnpm -C packages/harness test
```

## Usage

```bash
# Interactive TUI (default provider: anthropic)
mayac
mayac --provider openai --auth subscription

# Headless one-shot
mayac -p "add a /health route to server.ts and run the tests"

# Pick provider / model / auth explicitly
mayac --provider anthropic --model claude-opus-4-8 --auth subscription
mayac --provider openai   --model gpt-5.5         --auth subscription
```

### In the TUI

- Type a message + Enter to chat; streamed replies, tool calls + results render in the viewport.
- Header shows provider/model/auth, a live token ↑↓ and `$` cost meter, and `⚙ N bg` when tasks run.
- **Scroll:** PageUp/PageDown (auto-sticks to the newest output; `▼ N new below` when scrolled up); Esc jumps to the latest.
- **Tool calls:** `Ctrl+P`/`Ctrl+N` focus a call, `→`/Enter expand, `←` collapse, Esc leaves focus.
- **Autocomplete:** start `/` (commands), `@`/a path (files), or type a prefix of a past command (history) — Tab accepts, Esc dismisses, ↑/↓ moves.
- **While the agent works:** the input stays live — type + Enter to **queue** the next message; **Esc interrupts** the current turn.
- Line editing: ←/→ move, `ctrl+a`/`ctrl+e` home/end, `ctrl+w` delete word, `ctrl+u` clear, ↑/↓ history.
- `ctrl+c` twice to exit.

Slash commands:

| Command | Effect |
| --- | --- |
| `/model [id]` | switch model (no arg = picker; list fetched live) |
| `/provider [id]` | switch provider (no arg = picker) |
| `/auth [api\|subscription]` | switch auth mode |
| `/resume [id]` | reload a past session (no arg = picker) |
| `/bg <cmd>` | run a shell command as a background task |
| `/tasks` | view / kill background tasks |
| `/yolo` | toggle auto-approve for writes/bash |
| `/clear` | reset the conversation |
| `/help` | list commands + keybindings |
| `/quit` | exit |

Writes and bash prompt for permission (`y` = allow once, `a` = always/yolo, `n` = deny); reads auto-allow.

### Flags

| Flag | Meaning |
| --- | --- |
| `--provider <anthropic\|openai>` | Provider (default: `anthropic`) |
| `--model <id>` | Model override (default: provider's default) |
| `--auth <api\|subscription>` | Force auth mode (default: auto-detect, api-env first) |
| `--cwd <dir>` | Working directory (default: `process.cwd()`) |
| `-p, --print "<prompt>"` | Headless: run one prompt, stream to stdout, exit |
| `--resume [id]` | Reload a past session (no id = picker in the TUI) |
| `-c, --continue` | Continue the most recently updated session |
| `--yolo` | Auto-allow gated actions (writes/bash) — no prompts |
| `-h, --help` | Usage |

## Architecture

```
src/
  types.ts        # THE contract: Message/Tool/Provider/Auth/Session interfaces
  providers/      # Provider registry + factory; anthropic.ts, openai.ts adapters
  auth/           # AuthResolver per provider → Credential (api key | oauth token)
  loop/           # createSession: turn loop, tools, compaction, cost accounting
  tools/          # read/write/edit/bash/glob/grep/ls, each schema + permission gate
  models/         # listModels/fetchModels: live /v1/models discovery (cached)
  tasks/          # background bash task runner (start/list/output/kill)
  session/        # session persistence + command history (~/.maya-harness)
  tui/            # full-screen Ink app: App + ScrollView + AutocompleteMenu +
                  #   TasksView; lines/viewport/autocomplete/edit/transcript (pure)
  cli.ts          # arg parsing → auth → provider → session → TUI or headless
  prompt.ts       # default system prompt
```

Data flow: `cli` resolves a `Credential` via `resolveAuth`, builds a `Provider`
via `createProvider`, and constructs a `Session` (`createSession`). The TUI (or
headless loop) calls `session.run(userText)` and renders the streamed
`LoopEvent`s. The loop streams from the provider, runs any tool calls through the
permission gate, feeds results back, and repeats until the model ends its turn.

### Adding a provider

1. Add a `src/providers/<name>.ts` exporting `create<Name>Provider(cred): Provider`.
2. Add a catalog entry (models + pricing) and a `case` in `createProvider`.
3. Add an `AuthResolver` in `src/auth/`.

## License

MIT
