// Chaos: kill -9 the llama-server mid-life → supervisor restarts it; chat works after.
import assert from "node:assert";
import { defaultGuardrails, modelsDir } from "../../core/dist/index.js";
import { RuntimeManager } from "../dist/index.js";

const MODEL = "local/qwen2.5-0.5b-instruct"; // pulled by smoke.mjs
const mgr = new RuntimeManager(modelsDir(), defaultGuardrails());
const events = [];
mgr.on("event", (ev) => {
  events.push(ev);
  console.log("   [event]", JSON.stringify(ev));
});

console.log("1) load");
const inst = await mgr.load(MODEL, { contextLength: 4096 });
assert.equal(inst.state, "ready");
const pidBefore = inst.pid;
console.log("   ready, pid", pidBefore);

console.log("2) kill -9", pidBefore);
process.kill(pidBefore, "SIGKILL");

// wait for restart → ready (backoff 1s + startup; give it 90s)
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "instance_restarted") && inst.state === "ready") break;
  await new Promise((r) => setTimeout(r, 500));
}
assert(events.some((e) => e.type === "instance_restarted"), "restart event emitted");
assert.equal(inst.state, "ready", "instance recovered to ready");
assert.notEqual(inst.pid, pidBefore, "new pid after restart");
console.log("3) recovered: new pid", inst.pid);

console.log("4) chat after crash");
const res = await fetch(`http://127.0.0.1:${inst.port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "q", messages: [{ role: "user", content: "say OK" }], max_tokens: 8 }),
  signal: AbortSignal.timeout(60_000),
});
assert(res.ok, `chat HTTP ${res.status}`);
console.log("   reply ok");

await mgr.unloadAll();
console.log("\nCHAOS PASS ✅ (crash → auto-restart → serving again)");
process.exit(0);
