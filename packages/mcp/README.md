# @maya-ai/mcp

The MCP server the loop **Lead** uses to spawn + manage agents in its team.
Injected into the lead's Claude Code process via `--mcp-config`.

## Tools exposed to the lead

| Tool | Args | Effect |
|------|------|--------|
| `spawn_agent` | `{handle, type, model, cwd, role?, systemPrompt?}` | adds a live agent to the team |
| `list_agents` | — | current roster (handle/type/model/state) |
| `list_models` | — | spawnable models (id + `toolCalling` — prefer `true` for workers) |
| `stop_agent` | `{handle}` | retire a worker |
| `send_to` | `{handle, text}` | DM a teammate (wakes it on the bus) |

## How the orchestrator injects it into the lead (01's spawn seam)

When spawning the lead (a `claude-code` agent), add this MCP server to its
`--mcp-config` and pass the team context via env:

```json
{
  "mcpServers": {
    "maya": {
      "command": "node",
      "args": ["<repo-or-install>/packages/mcp/bin/maya-mcp.js"],
      "env": {
        "MAYA_ORCHESTRATOR_URL": "http://127.0.0.1:4400",
        "MAYA_GATEWAY_URL": "http://127.0.0.1:4100",
        "MAYA_TEAM_ID": "<the lead's teamId>"
      }
    }
  }
}
```

Only the **lead** gets this MCP (workers don't spawn). The env is how the
server knows which team to act on — no privileged bus token needed; spawning is
orchestrator-mediated (see `contracts/team.ts` § token).

## Endpoints it proxies (01 exposes on the persistent team)

```
POST   /api/teams/:id/agents          { agent: AgentSpec }  → spawn into the live team
DELETE /api/teams/:id/agents/:handle                        → stop_agent
GET    /api/teams/:id/agents                                → list_agents  (AgentStatus[])
POST   /api/teams/:id/messages        { to, text }          → send_to
```
`list_models` reads gateway `GET /api/models` (already live).

Until those land, the server is validated against a mock (`test/unit.mjs`) and
its protocol handshake is verified (`test/protocol.mjs`).
