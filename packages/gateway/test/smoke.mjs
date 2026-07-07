// Gateway smoke: boot on 4100, models list, on-demand chat, streaming, health, unload.
import assert from "node:assert";
import { defaultGuardrails, modelsDir } from "../../core/dist/index.js";
import { RuntimeManager } from "../../model-runtime/dist/index.js";
import { startGateway } from "../dist/index.js";

const mgr = new RuntimeManager(modelsDir(), defaultGuardrails());
const server = startGateway({ manager: mgr, modelsDir: modelsDir(), port: 4100 });
const base = "http://127.0.0.1:4100";
await new Promise((r) => setTimeout(r, 300));

console.log("1) GET /v1/models");
let res = await fetch(`${base}/v1/models`);
const models = (await res.json()).data;
console.log("   models:", models.map((m) => m.id).join(", "));
assert(models.some((m) => m.id === "local/qwen2.5-0.5b-instruct"), "catalog lists pulled model");

console.log("2) chat via gateway (model NOT loaded → on-demand start)");
res = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "local/qwen2.5-0.5b-instruct",
    messages: [{ role: "user", content: "Reply with exactly: GATEWAY-OK" }],
    max_tokens: 12, temperature: 0,
  }),
  signal: AbortSignal.timeout(120_000),
});
assert(res.ok, `chat HTTP ${res.status}`);
const text = (await res.json()).choices[0].message.content;
console.log("   reply:", JSON.stringify(text.trim()));

console.log("3) streaming chat");
res = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "local/qwen2.5-0.5b-instruct",
    messages: [{ role: "user", content: "count to three" }],
    max_tokens: 24, stream: true,
  }),
  signal: AbortSignal.timeout(120_000),
});
assert(res.ok && res.headers.get("content-type")?.includes("text/event-stream"), "SSE stream");
let chunks = 0;
for await (const _ of res.body) chunks++;
console.log("   stream chunks:", chunks);
assert(chunks > 1, "streamed multiple chunks");

console.log("4) health + instance visible");
const health = await (await fetch(`${base}/api/runtime/health`)).json();
console.log("   ram free:", (health.ramFreeBytes / 1024 ** 3).toFixed(1), "GB; instances:", health.instances.length);
assert(health.instances.length === 1, "one live instance");

console.log("5) unload via control API");
res = await fetch(`${base}/api/models/qwen2.5-0.5b-instruct/unload`, { method: "POST" });
assert((await res.json()).ok, "unload ok");
assert(mgr.instances().length === 0, "no instances");

console.log("6) bad model id → typed 400");
res = await fetch(`${base}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "qwen", messages: [] }),
});
assert.equal(res.status, 400);

console.log("\nGATEWAY SMOKE PASS ✅");
server.close();
await mgr.unloadAll();
process.exit(0);
