# Maya contracts (draft for review)

The frozen interfaces between the two work lanes. Change = PR + both agents (01, 02) sign off.

| Contract | File | Rule |
|----------|------|------|
| Model access | `models.ts` | Every layer above the gateway consumes models ONLY via gateway `ModelId`s (`local/…`, `openai/…`, `anthropic/…`). Nothing else ever sees a runtime port or process. |
| Runtime guardrails | `models.ts` | The Runtime Manager degrades (quant ↓, context ↓) before it ever refuses or crashes; hung processes get killed + restarted within `GuardrailPolicy` bounds. |
| Agent adapters | `agents.ts` | Orchestrator/dashboard touch agent processes only through `AgentAdapter` (preflight/spawn/pause/resume/kill/send/status/events/logs). |
| Loop protocol | `loop.ts` | Exactly five kinds on the bus: `task_assign` / `progress` / `done` / `question` / `answer`, wrapped as `body.maya`. Lead escalates to the human only what it cannot decide. |
| Bus | `bus.ts` | **Maya's own bus** (`packages/bus`, walkie-talkie-style protocol, fresh MIT code; `~/work/colate/cana-web` = read-only reference — owner directive 2026-07-08). Channel names `maya/team/<id>` + `maya/task/<id>`; per-agent tokens via env `MAYA_BUS_TOKEN`, least-capability. |
| Persistence | (02's scaffold) | One SQLite under `~/.maya/`; `packages/core` owns the schema; other packages go through core's repo layer, never raw SQL. |

## Owner decisions (2026-07-07/08)

- Product: **Maya** · npm package **`maya-os`** (bare `maya` is taken) · CLI binary **`maya`** · internal packages **`@maya-ai/*`** · license **MIT**.
- Hardware target: **all Apple M-series (M1 →)** — guardrail defaults must assume 8GB machines exist.
- Quality bar: never crash the host; degrade before refusing; fast; **no shortcuts** (~4-week build).

## Lanes

- **02 — model plane:** `packages/model-runtime`, `packages/gateway`, dashboard Models tab, M0 scaffold (`packages/core` skeleton + `apps/cli`).
- **01 — agent plane:** `packages/agent-runtime`, `packages/bus` (Maya's own), `packages/orchestrator` (+ Loop Agent), dashboard Agents/Teams tabs.
