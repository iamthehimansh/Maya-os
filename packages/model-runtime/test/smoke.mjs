// M1 model-runtime smoke test — real llama-server, real GGUF.
// Usage: node packages/model-runtime/test/smoke.mjs
import assert from "node:assert";
import { defaultGuardrails, modelsDir } from "../../core/dist/index.js";
import { RuntimeManager, pullModel, scanModels } from "../dist/index.js";

const MODELS = modelsDir();
const SOURCE = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf";

console.log("1) pull", SOURCE);
let lastPct = -10;
const model = await pullModel(MODELS, { source: SOURCE, name: "qwen2.5-0.5b-instruct" }, (ev) => {
  if (ev.pct >= lastPct + 10) { lastPct = ev.pct; console.log(`   pull ${ev.pct}%`); }
});
console.log("   pulled →", model);
assert(scanModels(MODELS).some((m) => `local/${m.name}` === model), "registry sees the model");

const mgr = new RuntimeManager(MODELS, defaultGuardrails());
mgr.on("event", (ev) => console.log("   [event]", JSON.stringify(ev)));

console.log("2) load", model);
const inst = await mgr.load(model, { contextLength: 4096 });
console.log("   instance", inst.id, "state", inst.state, "port", inst.port, "quant", inst.quant);
assert(["ready", "degraded"].includes(inst.state), "instance ready");

console.log("3) chat completion via instance");
const res = await fetch(`http://127.0.0.1:${inst.port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "qwen",
    messages: [{ role: "user", content: "Reply with exactly: MAYA-OK" }],
    max_tokens: 16,
    temperature: 0,
  }),
  signal: AbortSignal.timeout(60_000),
});
assert(res.ok, `chat HTTP ${res.status}`);
const body = await res.json();
const text = body.choices?.[0]?.message?.content ?? "";
console.log("   reply:", JSON.stringify(text.trim()));
assert(text.length > 0, "got a completion");

console.log("4) degrade path: fake 2.8GB available RAM (floor 2GB → ~0.8GB budget)");
await mgr.unloadAll();
process.env.MAYA_FAKE_AVAILABLE_RAM = String(Math.round(2.8 * 1024 ** 3));
const mgr2 = new RuntimeManager(MODELS, defaultGuardrails());
const events = [];
mgr2.on("event", (ev) => events.push(ev));
const inst2 = await mgr2.load(model, { contextLength: 32768 }); // huge ctx forces shrink
console.log("   plan under pressure: quant", inst2.quant, "ctx", inst2.contextLength, "state", inst2.state);
assert(inst2.contextLength < 32768, "context was auto-shrunk under RAM pressure");
delete process.env.MAYA_FAKE_AVAILABLE_RAM;

console.log("5) unload all");
await mgr2.unloadAll();
assert(mgr2.instances().length === 0, "no instances left");

console.log("\nSMOKE PASS ✅");
process.exit(0);
