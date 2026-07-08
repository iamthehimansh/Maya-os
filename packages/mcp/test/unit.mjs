import assert from "node:assert";
import { MayaClient } from "../dist/client.js";

// Mock fetch — record calls, return canned responses.
const calls = [];
const mockFetch = async (url, init) => {
  calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
  if (url.endsWith("/api/models")) return { ok: true, json: async () => [{ id: "local/qwen2.5-7b-instruct", toolCalling: true }, { id: "local/qwen2.5-coder-3b", toolCalling: false }] };
  return { ok: true, json: async () => ({ ok: true }) };
};
const client = new MayaClient({ orchestratorUrl: "http://o:4400", gatewayUrl: "http://g:4100", teamId: "team_x", fetchImpl: mockFetch });

// spawn_agent → POST /api/teams/team_x/agents { agent }
await client.spawnAgent({ handle: "@backend", type: "claude-code", model: "local/qwen2.5-7b-instruct", cwd: "/p" });
assert.equal(calls.at(-1).url, "http://o:4400/api/teams/team_x/agents");
assert.equal(calls.at(-1).method, "POST");
assert.equal(calls.at(-1).body.agent.handle, "@backend");

// list_agents → GET
await client.listAgents();
assert.equal(calls.at(-1).url, "http://o:4400/api/teams/team_x/agents");
assert.equal(calls.at(-1).method, "GET");

// stop_agent → DELETE with encoded handle
await client.stopAgent("@qa");
assert.equal(calls.at(-1).method, "DELETE");
assert(calls.at(-1).url.includes("%40qa"), "handle url-encoded");

// list_models → gateway, filters shape
const models = await client.listModels();
assert.equal(models.length, 2);
assert.equal(models[0].toolCalling, true);

// send_to → POST messages
await client.sendTo("@w1", "go");
assert.equal(calls.at(-1).url, "http://o:4400/api/teams/team_x/messages");
assert.equal(calls.at(-1).body.to, "@w1");

// error propagation
const errClient = new MayaClient({ orchestratorUrl: "http://o", gatewayUrl: "http://g", teamId: "t", fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "team not live" } }) }) });
await assert.rejects(() => errClient.spawnAgent({ handle: "@x", type: "codex", model: "m", cwd: "/" }), /team not live/);

console.log("MCP CLIENT PASS ✅ (7 checks)");
