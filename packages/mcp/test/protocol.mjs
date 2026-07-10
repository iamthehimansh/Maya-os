// Real MCP handshake: spawn the server bin, list tools via an MCP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "maya-mcp.js");
const transport = new StdioClientTransport({
  command: "node",
  args: [bin],
  env: { ...process.env, MAYA_TEAM_ID: "team_test" },
});
const client = new Client({ name: "test", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools exposed:", names.join(", "));
assert.deepEqual(names, ["list_agents", "list_models", "send_message", "send_to", "spawn_agent", "stop_agent"]);
console.log("MCP PROTOCOL PASS ✅ (server handshakes + exposes 6 tools)");
await client.close();
process.exit(0);
