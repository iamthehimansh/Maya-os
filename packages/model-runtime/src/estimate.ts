import type { LocalModel, Quant } from "@maya-ai/core";

/**
 * Quality score per quant (1 = lossless). Derived from published llama.cpp
 * perplexity-delta measurements (order-of-magnitude, model-family averaged):
 * Q8 is indistinguishable, Q6 near-lossless, Q4_K_M the sweet spot, Q3 shows
 * visible degradation. Used to trade quant level against context size.
 */
export const QUANT_QUALITY: Record<Quant, number> = {
  F16: 1.0,
  Q8_0: 0.998,
  Q6_K: 0.99,
  Q5_K_M: 0.98,
  Q4_K_M: 0.955,
  Q3_K_M: 0.90,
};

/**
 * "Will it fit?" — conservative planning numbers, not precision. Weights load
 * ≈ file size (mmap'd, but Metal wires most of it); KV cache and compute
 * buffers come on top and scale with context.
 *
 * KV ≈ 2 (K+V) · layers · kvHeads · headDim · 2 bytes (f16) · ctx. We don't
 * parse GGUF headers in v1, so approximate KV+overhead as a fraction of model
 * size scaled by context — validated against llama.cpp logs on M-series for
 * 3B–14B models; err on the high side (guardrails would rather under-admit).
 */
export function estimateLoadBytes(fileBytes: number, contextLength: number): number {
  const MIB = 1024 * 1024;
  const weights = fileBytes;
  // Fixed compute buffers scale with model size but are bounded — a 0.5B model
  // doesn't allocate what a 70B does. Kept separate from KV so context shrink
  // actually reduces the estimate for small models too (guardrail must have a
  // working second axis at every model size).
  const buffers = Math.max(128 * MIB, Math.min(512 * MIB, weights * 0.25));
  // KV runs quantized to q8 (half of f16) — keep this in sync with the
  // --cache-type-k/v defaults in backends/llamacpp.ts.
  const kv = weights * 0.075 * (contextLength / 8192);
  return Math.round(weights + buffers + kv);
}

export interface FitPlan {
  quant: Quant;
  fileBytes: number;
  contextLength: number;
  estimateBytes: number;
  degraded: { quant: boolean; context: boolean };
}

/**
 * 2-D fit planner: evaluate every (quant × context) pair that fits the budget
 * and pick the best by a quality-aware score, instead of the old sequential
 * ladder (which would take Q8@2k over Q6@8k — usually the wrong trade for
 * agent workloads that need room to think).
 *
 * Score = quantQuality × contextValue, where contextValue has diminishing
 * returns past the requested context and a hard preference floor at 8k for
 * requests ≥8k (agents send 20k+ prompts — a 2k-context "fit" is a lie).
 */
export function planFit(
  files: LocalModel["files"],
  preferredQuant: Quant | undefined,
  contextLength: number,
  budgetBytes: number,
  ladder: (from: Quant) => Quant[],
): FitPlan | null {
  const byQuant = new Map(files.map((f) => [f.quant, f]));
  const startQuant = preferredQuant ?? files[0]?.quant;
  if (!startQuant) return null;
  const candidates = ladder(startQuant).filter((q) => byQuant.has(q));
  if (!candidates.length) return null;

  const ctxSteps: number[] = [];
  for (let ctx = contextLength; ctx >= 2048; ctx = Math.floor(ctx / 2)) ctxSteps.push(ctx);

  let best: (FitPlan & { score: number }) | null = null;
  for (const quant of candidates) {
    const f = byQuant.get(quant)!;
    for (const ctx of ctxSteps) {
      const est = estimateLoadBytes(f.bytes, ctx);
      if (est > budgetBytes) continue;
      // Context value: linear up to the request, sqrt-diminishing past a 8k
      // floor; heavily penalize sub-8k when ≥8k was asked for.
      const ratio = ctx / contextLength;
      const ctxValue = (contextLength >= 8192 && ctx < 8192 ? 0.5 : 1) * Math.sqrt(ratio);
      const score = (QUANT_QUALITY[quant] ?? 0.9) * ctxValue;
      if (!best || score > best.score) {
        best = {
          quant,
          fileBytes: f.bytes,
          contextLength: ctx,
          estimateBytes: est,
          degraded: { quant: quant !== startQuant, context: ctx !== contextLength },
          score,
        };
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...plan } = best;
  return plan;
}
