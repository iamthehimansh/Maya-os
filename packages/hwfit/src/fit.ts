import type { Quant } from "@maya-ai/core";
import { estimateLoadBytes } from "@maya-ai/model-runtime";
import type { CatalogModel, FitLevel, RunMode, SystemInfo } from "./types.js";

const GB = 1024 ** 3;

/**
 * Effective bits per weight for each quant on Maya's ladder — llama.cpp's
 * published figures, which include the block scales/mins, so they are NOT the
 * round numbers the names imply (Q4_K_M is 4.83 bpw, not 4.0). Using 4.0 here
 * would under-estimate a 32B model by ~3 GB, which is exactly the size of the
 * error that turns a "fits" into an OOM.
 */
export const QUANT_BPW: Record<Quant, number> = {
  F16: 16.0,
  Q8_0: 8.5,
  Q6_K: 6.56,
  Q5_K_M: 5.67,
  Q4_K_M: 4.83,
  Q3_K_M: 3.91,
};

/** Best → smallest. The order the planner walks when a model doesn't fit. */
export const QUANT_LADDER: Quant[] = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];

/** Maya's agent floor (see model-runtime's tune.ts): below 8k, agents choke. */
export const DEFAULT_TARGET_CONTEXT = 8192;

/** Never recommend a context below this — a 512-token window isn't a product. */
const MIN_CONTEXT = 1024;

/** On-disk/in-memory size of the weights alone, in bytes. */
export function weightBytes(paramsB: number, quant: Quant): number {
  return (paramsB * 1e9 * QUANT_BPW[quant]) / 8;
}

/**
 * Total memory to load this model at this quant/context, in GB.
 *
 * Delegates to model-runtime's `estimateLoadBytes` (weights + compute buffers
 * + KV) rather than re-deriving the arithmetic. That is deliberate: the
 * runtime manager uses that same function to decide whether to admit a load,
 * so if we estimated independently we could cheerfully recommend a model the
 * guardrail then refuses to start. One estimator, one answer.
 *
 * For MoE this is conservative — every expert must be resident (so `paramsB`
 * is total, not active), and the KV term is a fraction of weights, which
 * over-counts for MoE. Over-counting is the safe direction.
 */
export function estimateMemoryGb(model: CatalogModel, quant: Quant, context: number): number {
  const bytes = estimateLoadBytes(weightBytes(model.paramsB, quant), context);
  return round2(bytes / GB);
}

/**
 * Memory we're willing to hand a model, in GB.
 *
 * Planned against TOTAL memory, not what's free this instant: this is a "what
 * should I download?" recommender, and the user can quit Chrome. Ranking off
 * live free RAM would make the list flicker between page loads. `availableRamGb`
 * is still reported on SystemInfo so the UI can warn about right-now pressure.
 */
export function budgetGb(system: SystemInfo): number {
  if (system.backend === "cuda" && system.vramGb) return round2(system.vramGb * 0.9);
  // Unified memory: the OS, the window server and the user's editor also live
  // here. ~20% held back matches Maya's 2 GiB guardrail floor at 16 GB and
  // scales sanely up to 128 GB.
  if (system.isAppleSilicon) return round2(system.totalRamGb * 0.8);
  return round2(system.totalRamGb * 0.7);
}

/**
 * Fit bands, as ratios of required ÷ budget. Ported from odysseus: the point
 * is that "it fits" is not binary. A model at 95% of budget technically loads
 * and then degrades the moment you open a browser tab.
 */
export function fitLevelFor(ratio: number): FitLevel {
  if (ratio <= 0.5) return "perfect";
  if (ratio <= 0.75) return "good";
  if (ratio <= 0.9) return "marginal";
  if (ratio <= 1.0) return "too_tight";
  return "no_fit";
}

export interface FitPlan {
  quant: Quant;
  context: number;
  requiredGb: number;
  fitLevel: FitLevel;
  runMode: RunMode;
  /** True when we had to halve the context below what was asked for. */
  contextReduced: boolean;
}

function runModeFor(system: SystemInfo, fit: FitLevel, requiredGb: number): RunMode {
  if (fit === "no_fit") return "none";
  if (system.backend === "cpu") return "cpu";
  if (system.backend === "cuda") {
    // Discrete GPU: weights beyond VRAM spill to system RAM over PCIe — it
    // runs, but slowly. Unified memory has no such split.
    return system.vramGb && requiredGb > system.vramGb ? "hybrid" : "gpu";
  }
  return "gpu";
}

/**
 * Plan one (model × quant) against the machine: keep the largest context that
 * fits, halving from `targetContext` down to 1024 before giving up.
 *
 * Returns a `no_fit` plan (rather than null) so callers can still SHOW the
 * model and explain why it's out of reach — "too big" is useful information.
 */
export function planFit(
  model: CatalogModel,
  quant: Quant,
  system: SystemInfo,
  targetContext: number = DEFAULT_TARGET_CONTEXT,
): FitPlan {
  const budget = budgetGb(system);
  // Never promise more context than the model was trained for.
  const top = Math.min(targetContext, model.contextLength);

  let context = Math.max(top, MIN_CONTEXT);
  let required = estimateMemoryGb(model, quant, context);

  while (required / budget > 1.0 && context > MIN_CONTEXT) {
    context = Math.max(MIN_CONTEXT, Math.floor(context / 2));
    required = estimateMemoryGb(model, quant, context);
  }

  const ratio = required / budget;
  const fitLevel = fitLevelFor(ratio);
  return {
    quant,
    context,
    requiredGb: required,
    fitLevel,
    runMode: runModeFor(system, fitLevel, required),
    contextReduced: context < top,
  };
}

/**
 * Estimated generation throughput, tokens/sec.
 *
 * Roofline: decode is memory-bound, so tok/s ≈ bandwidth ÷ bytes-read-per-token.
 * MoE reads only its active experts per token, which is the entire reason a
 * 30B-A3B feels like a 3B while weighing 30B — so speed keys off active params
 * while memory keys off total. The efficiency factor is the fraction of peak
 * bandwidth llama.cpp actually achieves in practice (never 100%).
 */
export function estimateTps(model: CatalogModel, quant: Quant, system: SystemInfo): number {
  const activeB = model.isMoe ? (model.activeParamsB ?? model.paramsB) : model.paramsB;
  const activeGb = weightBytes(activeB, quant) / GB;
  if (activeGb <= 0) return 0;

  // Sustained fraction of peak bandwidth. MoE pays a routing/gather penalty on
  // top, so it never reaches the dense figure for the same active size.
  const efficiency = 0.75 * (model.isMoe ? 0.8 : 1);
  const tps = (system.memoryBandwidthGbs / activeGb) * efficiency;
  return round1(tps);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
