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
  "--ctx-size", "4096", "--jinja",
  "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0",
  "--no-webui", "--metrics",
]);
assert(!llamaServerArgs({ modelPath: "/m.gguf", port: 1, contextLength: 1 }).includes("--alias"), "alias optional");
// --n-gpu-layers is OMITTED by default so llama.cpp auto-fits layers to free
// memory. Hardcoding 999 made it refuse to fit and OOM on Metal for a model
// bigger than free VRAM. Still passed through when set explicitly.
assert(!args.includes("--n-gpu-layers"), "n-gpu-layers omitted by default (llama.cpp auto-fits)");
const pinned = llamaServerArgs({ modelPath: "/m.gguf", port: 1, contextLength: 1, nGpuLayers: 24 });
assert.deepEqual(pinned.slice(pinned.indexOf("--n-gpu-layers"), pinned.indexOf("--n-gpu-layers") + 2), ["--n-gpu-layers", "24"], "explicit nGpuLayers honored");

console.log("UNIT PASS ✅ (12 assertions)");

// draft argv (speculation flags appended only when draftPath present)
const dargs = llamaServerArgs({ modelPath: "/m.gguf", port: 1, contextLength: 2048, draftPath: "/d.gguf" });
assert(dargs.includes("--model-draft") && dargs.includes("/d.gguf") && dargs.includes("--gpu-layers-draft"), "draft flags present");
// --spec-type is REQUIRED to actually enable speculation (build 9890+): without
// it --model-draft is a silent no-op and the draft never loads. Guard the fix.
assert(dargs.includes("--spec-type") && dargs.includes("draft-simple"), "spec-type enables speculation");
assert(dargs.includes("--spec-draft-p-min"), "draft p-min tuned");
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

// Split-GGUF registry: a 2-part split collapses to part-1 with SUMMED bytes.
import { scanModels } from "../dist/registry.js";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), "maya-split-"));
const md = path2.join(tmp, "big-model");
fs2.mkdirSync(md, { recursive: true });
fs2.writeFileSync(path2.join(md, "big-model-Q4_K_M-00001-of-00002.gguf"), Buffer.alloc(1000));
fs2.writeFileSync(path2.join(md, "big-model-Q4_K_M-00002-of-00002.gguf"), Buffer.alloc(500));
const found = scanModels(tmp).find((m) => m.name === "big-model");
assert(found, "split model found");
assert.equal(found.files.length, 1, "split collapses to ONE representative file");
assert(found.files[0].path.includes("00001-of-00002"), "representative = part-1 (llama.cpp loads the set from it)");
assert.equal(found.files[0].bytes, 1500, "representative carries the SUMMED size");
fs2.rmSync(tmp, { recursive: true, force: true });
console.log("SPLIT GGUF PASS ✅");

// maya tune search space — pure (quant × context × draft) enumeration, RAM-fit.
import { buildSearchSpace } from "../dist/tune.js";
const tuneFiles = [
  { quant: "Q8_0", path: "/x/q8.gguf", bytes: 8 * GIB },
  { quant: "Q4_K_M", path: "/x/q4.gguf", bytes: 4 * GIB },
];

// Plenty of RAM: full grid = 2 quants × 3 contexts (32k,16k,8k), no drafts.
let space = buildSearchSpace(tuneFiles, { minCtx: 8192, targetCtx: 32768, budgetBytes: 40 * GIB });
assert.equal(space.length, 6, "2 quants × 3 contexts");
assert(space.every((c) => c.contextLength >= 8192), "never below minCtx");
assert(space.every((c) => c.draft === undefined), "no drafts when none offered");
// Bench order: best quality × largest context first.
assert.equal(space[0].quant, "Q8_0");
assert.equal(space[0].contextLength, 32768);

// RAM-fit filter: a tight budget drops the big-quant / big-context corners.
space = buildSearchSpace(tuneFiles, { minCtx: 8192, targetCtx: 32768, budgetBytes: 6 * GIB });
assert(space.length > 0 && space.every((c) => c.estimateBytes <= 6 * GIB), "every candidate fits the budget");
assert(space.every((c) => c.quant === "Q4_K_M"), "Q8 doesn't fit 6GB → only Q4 survives");

// minCtx guard: a budget too small even for minCtx yields an empty space.
assert.equal(buildSearchSpace(tuneFiles, { minCtx: 8192, targetCtx: 8192, budgetBytes: 1 * GIB }).length, 0, "nothing fits → empty");

// quants filter restricts the axis.
space = buildSearchSpace(tuneFiles, { minCtx: 8192, targetCtx: 8192, budgetBytes: 40 * GIB, quants: ["Q4_K_M"] });
assert(space.every((c) => c.quant === "Q4_K_M"), "quants filter honored");

// Drafts add a parallel candidate set, and their reserve counts against budget.
const drafts = [{ name: "tiny", path: "/x/tiny.gguf", bytes: 0.4 * GIB }];
space = buildSearchSpace(tuneFiles, { minCtx: 8192, targetCtx: 8192, budgetBytes: 40 * GIB, drafts });
assert(space.some((c) => c.draft === "tiny"), "draft candidates present");
assert(space.some((c) => c.draft === undefined), "no-draft baseline still present");
const withDraft = space.find((c) => c.quant === "Q4_K_M" && c.draft === "tiny");
const noDraft = space.find((c) => c.quant === "Q4_K_M" && c.draft === undefined);
assert(withDraft.estimateBytes > noDraft.estimateBytes, "draft reserve raises the estimate");
console.log("TUNE SEARCH SPACE PASS ✅");
