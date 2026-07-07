// Unit tests for pure logic — no processes, no network.  node test/unit.mjs
import assert from "node:assert";
import { estimateLoadBytes, planFit } from "../dist/estimate.js";
import { quantFromFilename, quantLadderFrom } from "../dist/registry.js";
import { llamaServerArgs } from "../dist/backends/llamacpp.js";

const GIB = 1024 ** 3;

// quant parsing
assert.equal(quantFromFilename("qwen3-4b-Q4_K_M.gguf"), "Q4_K_M");
assert.equal(quantFromFilename("model.q8_0.gguf"), "Q8_0");
assert.equal(quantFromFilename("weird-name.gguf"), undefined);

// ladder
assert.deepEqual(quantLadderFrom("Q6_K"), ["Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"]);

// estimate grows with context
assert(estimateLoadBytes(4 * GIB, 32768) > estimateLoadBytes(4 * GIB, 8192));

const files = [
  { quant: "Q8_0", path: "/x/q8.gguf", bytes: 8 * GIB },
  { quant: "Q6_K", path: "/x/q6.gguf", bytes: 6 * GIB },
  { quant: "Q4_K_M", path: "/x/q4.gguf", bytes: 4 * GIB },
];

// plenty of RAM → preferred quant, full context
let plan = planFit(files, "Q8_0", 8192, 20 * GIB, quantLadderFrom);
assert.equal(plan.quant, "Q8_0");
assert.deepEqual(plan.degraded, { quant: false, context: false });

// tight RAM → quant degrades before context
plan = planFit(files, "Q8_0", 8192, 6 * GIB, quantLadderFrom);
assert.equal(plan.quant, "Q4_K_M");
assert.equal(plan.degraded.quant, true);
assert.equal(plan.degraded.context, false);

// very tight → smallest quant + shrunken context
plan = planFit(files, "Q8_0", 32768, 5 * GIB, quantLadderFrom);
assert.equal(plan.quant, "Q4_K_M");
assert(plan.contextLength < 32768);
assert.equal(plan.degraded.context, true);

// impossible → null (caller refuses cleanly)
assert.equal(planFit(files, "Q8_0", 8192, 1 * GIB, quantLadderFrom), null);

// argv builder is exact (contract with llama-server flags)
const args = llamaServerArgs({ modelPath: "/m.gguf", port: 41100, contextLength: 4096, alias: "local/m" });
assert.deepEqual(args, [
  "--model", "/m.gguf", "--alias", "local/m", "--port", "41100", "--host", "127.0.0.1",
  "--ctx-size", "4096", "--n-gpu-layers", "999", "--jinja",
  "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0",
  "--no-webui", "--metrics",
]);
assert(!llamaServerArgs({ modelPath: "/m.gguf", port: 1, contextLength: 1 }).includes("--alias"), "alias optional");

console.log("UNIT PASS ✅ (12 assertions)");

// draft argv (speculation flags appended only when draftPath present)
const dargs = llamaServerArgs({ modelPath: "/m.gguf", port: 1, contextLength: 2048, draftPath: "/d.gguf" });
assert(dargs.includes("--model-draft") && dargs.includes("/d.gguf") && dargs.includes("--gpu-layers-draft"), "draft flags present");
assert(!llamaServerArgs({ modelPath: "/m.gguf", port: 1, contextLength: 2048 }).includes("--model-draft"), "no draft by default");
console.log("DRAFT ARGV PASS ✅");

// 2-D planner win case: the old ladder shrank context ONLY on the SMALLEST
// quant — with [Q6, Q3] asking 32k on a budget where neither fits full,
// it picked Q3@16k; the 2-D planner finds Q6@16k (better quality, same ctx).
const files2 = [
  { quant: "Q6_K", path: "/x/q6.gguf", bytes: 6 * GIB },
  { quant: "Q3_K_M", path: "/x/q3.gguf", bytes: 5.68 * GIB },
];
plan = planFit(files2, "Q6_K", 32768, 7.6 * GIB, quantLadderFrom);
assert.equal(plan.quant, "Q6_K", "2-D keeps the better quant (old ladder chose Q3)");
assert.equal(plan.contextLength, 16384, "at the shrunk context");

// full-requested-context at sweet-spot quant beats higher quant at half ctx
const files3 = [
  { quant: "Q6_K", path: "/x/q6.gguf", bytes: 6 * GIB },
  { quant: "Q4_K_M", path: "/x/q4.gguf", bytes: 4 * GIB },
];
plan = planFit(files3, "Q6_K", 32768, 7.6 * GIB, quantLadderFrom);
assert.equal(plan.quant, "Q4_K_M", "context dominates: Q4@full beats Q6@half");
assert.equal(plan.contextLength, 32768);

// agent floor: when 8k+ fits at ANY quant, never pick a sub-8k plan
plan = planFit(files3, "Q6_K", 16384, 6.8 * GIB, quantLadderFrom);
assert(plan.contextLength >= 8192, "agent floor: never sub-8k when 8k+ fits");
console.log("2D PLANNER PASS ✅");
