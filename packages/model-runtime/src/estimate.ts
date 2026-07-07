import type { LocalModel, Quant } from "@maya-ai/core";

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
 * Walk the degrade ladder: preferred quant at full context → smaller quants →
 * then shrink context (halving, floor 2048) on the smallest quant. First plan
 * that fits the RAM budget wins; null = nothing fits (caller refuses cleanly).
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

  for (const quant of candidates) {
    const f = byQuant.get(quant)!;
    const est = estimateLoadBytes(f.bytes, contextLength);
    if (est <= budgetBytes) {
      return {
        quant,
        fileBytes: f.bytes,
        contextLength,
        estimateBytes: est,
        degraded: { quant: quant !== startQuant, context: false },
      };
    }
  }
  // Smallest quant still too big → shrink context
  const smallest = candidates[candidates.length - 1]!;
  const f = byQuant.get(smallest)!;
  for (let ctx = contextLength; ctx >= 2048; ctx = Math.floor(ctx / 2)) {
    const est = estimateLoadBytes(f.bytes, ctx);
    if (est <= budgetBytes) {
      return {
        quant: smallest,
        fileBytes: f.bytes,
        contextLength: ctx,
        estimateBytes: est,
        degraded: { quant: smallest !== startQuant, context: ctx !== contextLength },
      };
    }
  }
  return null;
}
