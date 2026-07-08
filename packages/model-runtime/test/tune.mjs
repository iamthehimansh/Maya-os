// maya tune live micro-bench — real llama-server, real tok/s.
// Usage: node packages/model-runtime/test/tune.mjs
import assert from "node:assert";
import { modelsDir } from "../../core/dist/index.js";
import { scanModels, tuneModel } from "../dist/index.js";

const MODELS = modelsDir();
const NAME = process.env.TUNE_MODEL ?? "qwen2.5-0.5b-instruct";
const local = scanModels(MODELS).find((m) => m.name === NAME);
assert(local, `model not installed: ${NAME} (set TUNE_MODEL=<name>)`);

console.log(`tuning ${NAME} — ${local.files.map((f) => f.quant).join(", ")}`);
const report = await tuneModel(MODELS, local, [], {
  // Small, fast search for the smoke test: one quant, two contexts, few tokens.
  minCtx: 2048,
  targetCtx: 4096,
  genTokens: 48,
  onProgress: (ev) => {
    if (ev.kind === "plan") console.log(`  plan: ${ev.candidates} candidates`);
    if (ev.kind === "bench") console.log(`  [${ev.index + 1}/${ev.total}] bench ${ev.candidate.quant} @ ${ev.candidate.contextLength}${ev.candidate.draft ? ` +draft ${ev.candidate.draft}` : ""}`);
    if (ev.kind === "result") {
      const r = ev.result;
      console.log(`      → ${r.ok ? `${r.genTokPerSec} tok/s gen, ${r.promptTokPerSec} tok/s prompt, load ${r.loadMs}ms` : `FAILED: ${r.error}`}`);
    }
  },
});

assert(report.results.length > 0, "benched at least one candidate");
assert(report.best, "found a best config");
assert(report.best.genTokPerSec > 0, "measured a real generation tok/s");
console.log(`\nBEST: ${report.best.candidate.quant} @ ${report.best.candidate.contextLength} → ${report.best.genTokPerSec} tok/s`);
console.log("\nTUNE LIVE PASS ✅");
process.exit(0);
