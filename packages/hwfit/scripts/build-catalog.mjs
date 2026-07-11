/**
 * Regenerate src/data/seed.ts — the curated, offline catalog.
 *
 * Every GGUF filename in the seed is RESOLVED against the live HuggingFace API
 * rather than guessed from a template, because repos do not agree on casing:
 *   Qwen/Qwen2.5-Coder-7B-Instruct-GGUF → qwen2.5-coder-7b-instruct-q4_k_m.gguf
 *   Qwen/Qwen3-8B-GGUF                  → Qwen3-8B-Q4_K_M.gguf
 * A guessed filename is a download button that 404s, so we bake in real ones.
 *
 * Run:  pnpm --filter @maya-ai/hwfit catalog:refresh
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const QUANTS = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];

/** Curated metadata. Params/context/MoE come from each model's own card. */
const SEED = [
  { name: "qwen2.5-coder-1.5b", displayName: "Qwen2.5-Coder 1.5B", provider: "qwen", paramsB: 1.5, isMoe: false, arch: "qwen2.5", contextLength: 32768, coding: true, hfRepo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF", mlxRepo: "mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit", releasedAt: "2024-11-12" },
  { name: "qwen2.5-coder-3b", displayName: "Qwen2.5-Coder 3B", provider: "qwen", paramsB: 3.1, isMoe: false, arch: "qwen2.5", contextLength: 32768, coding: true, hfRepo: "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF", mlxRepo: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit", releasedAt: "2024-11-12" },
  { name: "qwen2.5-coder-7b", displayName: "Qwen2.5-Coder 7B", provider: "qwen", paramsB: 7.6, isMoe: false, arch: "qwen2.5", contextLength: 32768, coding: true, hfRepo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", mlxRepo: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", releasedAt: "2024-11-12" },
  { name: "qwen2.5-coder-14b", displayName: "Qwen2.5-Coder 14B", provider: "qwen", paramsB: 14.7, isMoe: false, arch: "qwen2.5", contextLength: 32768, coding: true, hfRepo: "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF", mlxRepo: "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit", releasedAt: "2024-11-12" },
  { name: "qwen2.5-coder-32b", displayName: "Qwen2.5-Coder 32B", provider: "qwen", paramsB: 32.8, isMoe: false, arch: "qwen2.5", contextLength: 32768, coding: true, hfRepo: "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF", mlxRepo: "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit", releasedAt: "2024-11-12" },
  { name: "qwen3-4b", displayName: "Qwen3 4B", provider: "qwen", paramsB: 4.0, isMoe: false, arch: "qwen3", contextLength: 32768, coding: false, hfRepo: "Qwen/Qwen3-4B-GGUF", releasedAt: "2025-04-29" },
  { name: "qwen3-8b", displayName: "Qwen3 8B", provider: "qwen", paramsB: 8.2, isMoe: false, arch: "qwen3", contextLength: 32768, coding: false, hfRepo: "Qwen/Qwen3-8B-GGUF", releasedAt: "2025-04-29" },
  { name: "qwen3-14b", displayName: "Qwen3 14B", provider: "qwen", paramsB: 14.8, isMoe: false, arch: "qwen3", contextLength: 32768, coding: false, hfRepo: "Qwen/Qwen3-14B-GGUF", releasedAt: "2025-04-29" },
  { name: "qwen3-32b", displayName: "Qwen3 32B", provider: "qwen", paramsB: 32.8, isMoe: false, arch: "qwen3", contextLength: 32768, coding: false, hfRepo: "Qwen/Qwen3-32B-GGUF", releasedAt: "2025-04-29" },
  { name: "qwen3-30b-a3b", displayName: "Qwen3 30B-A3B (MoE)", provider: "qwen", paramsB: 30.5, activeParamsB: 3.3, isMoe: true, arch: "qwen3", contextLength: 32768, coding: false, hfRepo: "Qwen/Qwen3-30B-A3B-GGUF", releasedAt: "2025-04-29" },
  { name: "deepseek-coder-v2-lite-16b", displayName: "DeepSeek-Coder-V2 Lite 16B (MoE)", provider: "deepseek", paramsB: 15.7, activeParamsB: 2.4, isMoe: true, arch: "deepseek-v2", contextLength: 32768, coding: true, hfRepo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF", releasedAt: "2024-06-17" },
  { name: "deepseek-r1-distill-qwen-7b", displayName: "DeepSeek-R1 Distill Qwen 7B", provider: "deepseek", paramsB: 7.6, isMoe: false, arch: "deepseek-r1", contextLength: 32768, coding: false, hfRepo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF", releasedAt: "2025-01-20" },
  { name: "deepseek-r1-distill-qwen-14b", displayName: "DeepSeek-R1 Distill Qwen 14B", provider: "deepseek", paramsB: 14.8, isMoe: false, arch: "deepseek-r1", contextLength: 32768, coding: false, hfRepo: "bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF", releasedAt: "2025-01-20" },
  { name: "deepseek-r1-distill-qwen-32b", displayName: "DeepSeek-R1 Distill Qwen 32B", provider: "deepseek", paramsB: 32.8, isMoe: false, arch: "deepseek-r1", contextLength: 32768, coding: false, hfRepo: "bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF", releasedAt: "2025-01-20" },
  { name: "llama-3.2-3b", displayName: "Llama 3.2 3B", provider: "meta", paramsB: 3.2, isMoe: false, arch: "llama3.2", contextLength: 131072, coding: false, hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF", releasedAt: "2024-09-25" },
  { name: "llama-3.1-8b", displayName: "Llama 3.1 8B", provider: "meta", paramsB: 8.0, isMoe: false, arch: "llama3.1", contextLength: 131072, coding: false, hfRepo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", releasedAt: "2024-07-23" },
  { name: "llama-3.3-70b", displayName: "Llama 3.3 70B", provider: "meta", paramsB: 70.6, isMoe: false, arch: "llama3.3", contextLength: 131072, coding: false, hfRepo: "bartowski/Llama-3.3-70B-Instruct-GGUF", releasedAt: "2024-12-06" },
  { name: "mistral-nemo-12b", displayName: "Mistral Nemo 12B", provider: "mistral", paramsB: 12.2, isMoe: false, arch: "mistral-nemo", contextLength: 131072, coding: false, hfRepo: "bartowski/Mistral-Nemo-Instruct-2407-GGUF", releasedAt: "2024-07-18" },
  { name: "codestral-22b", displayName: "Codestral 22B", provider: "mistral", paramsB: 22.2, isMoe: false, arch: "mistral", contextLength: 32768, coding: true, hfRepo: "bartowski/Codestral-22B-v0.1-GGUF", releasedAt: "2024-05-29" },
  { name: "gemma-2-9b", displayName: "Gemma 2 9B", provider: "google", paramsB: 9.2, isMoe: false, arch: "gemma2", contextLength: 8192, coding: false, hfRepo: "bartowski/gemma-2-9b-it-GGUF", releasedAt: "2024-06-27" },
  { name: "phi-4-14b", displayName: "Phi-4 14B", provider: "microsoft", paramsB: 14.7, isMoe: false, arch: "phi4", contextLength: 16384, coding: false, hfRepo: "bartowski/phi-4-GGUF", releasedAt: "2024-12-12" },
];

/** Split GGUFs (…-00001-of-00003.gguf) — llama.cpp loads the set from part 1. */
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

async function resolveRepo(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = await res.json();
  const files = (info.siblings ?? [])
    .map((s) => s.rfilename)
    .filter((f) => f.endsWith(".gguf"));

  const out = {};
  for (const quant of QUANTS) {
    // Anchor on the quant token immediately before .gguf so Q4_K_M never
    // matches a Q4_K_S file. Case-insensitive: repos disagree on casing.
    const exact = new RegExp(`[-._]${quant}\\.gguf$`, "i");
    const hit = files.find((f) => exact.test(f) && !SPLIT_RE.test(f));
    if (hit) {
      out[quant] = hit;
      continue;
    }
    // Split set: point at part 1, which is what llama.cpp (and Maya's
    // download.ts) expect as the entry point for the whole set.
    const splitFirst = files.find(
      (f) => new RegExp(`[-._]${quant}-00001-of-\\d{5}\\.gguf$`, "i").test(f),
    );
    if (splitFirst) out[quant] = splitFirst;
  }
  return out;
}

const resolved = [];
for (const model of SEED) {
  try {
    const ggufFiles = await resolveRepo(model.hfRepo);
    const n = Object.keys(ggufFiles).length;
    if (!n) {
      console.warn(`⚠️  ${model.name}: no matching quants in ${model.hfRepo} — skipped`);
      continue;
    }
    resolved.push({ ...model, ggufFiles });
    console.log(`✅ ${model.name.padEnd(28)} ${n} quants  (${Object.keys(ggufFiles).join(", ")})`);
  } catch (err) {
    console.warn(`⚠️  ${model.name}: ${model.hfRepo} → ${err.message} — skipped`);
  }
}

const header = `// GENERATED by scripts/build-catalog.mjs — do not edit by hand.
// Every gguf filename here was resolved against the live HuggingFace API, so
// the pull sources this package emits are real, not templated guesses.
// Refresh with: pnpm --filter @maya-ai/hwfit catalog:refresh
import type { CatalogModel } from "../types.js";

export const SEED_CATALOG: CatalogModel[] = ${JSON.stringify(resolved, null, 2)};
`;

const dest = path.join(fileURLToPath(new URL("../src/data/", import.meta.url)), "seed.ts");
writeFileSync(dest, header);
console.log(`\nWrote ${resolved.length} models → ${dest}`);
