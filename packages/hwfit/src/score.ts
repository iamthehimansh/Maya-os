import type { Quant } from "@maya-ai/core";
import { QUANT_QUALITY } from "@maya-ai/model-runtime";
import type { CatalogModel, FitLevel, Subscores, UseCase } from "./types.js";

/**
 * What each use case actually wants. Coding is quality-dominant: a wrong patch
 * produced at 80 tok/s is worthless, so correctness outweighs latency. Chat
 * cares far more about responsiveness, because a human is reading along at
 * ~10 tok/s and a stall is felt immediately.
 */
export const WEIGHTS: Record<UseCase, Subscores> = {
  coding: { quality: 0.5, speed: 0.2, fit: 0.15, context: 0.15 },
  chat: { quality: 0.4, speed: 0.35, fit: 0.15, context: 0.1 },
  reasoning: { quality: 0.55, speed: 0.25, fit: 0.1, context: 0.1 },
};

/**
 * Tokens/sec at which the speed subscore saturates. Reading speed is ~10 tok/s,
 * so chat saturates early; a coding agent streams a whole file and a reasoning
 * model burns hundreds of thinking tokens before it says anything, so both stay
 * hungry for more throughput.
 */
const SPEED_TARGET: Record<UseCase, number> = {
  coding: 30,
  chat: 20,
  reasoning: 40,
};

/** Capability by parameter count. Diminishing returns — 70B is not 10× a 7B. */
function paramTier(paramsB: number): number {
  if (paramsB < 1) return 20;
  if (paramsB < 3) return 35;
  if (paramsB < 5) return 50;
  if (paramsB < 9) return 65;
  if (paramsB < 16) return 75;
  if (paramsB < 25) return 82;
  if (paramsB < 40) return 88;
  if (paramsB < 75) return 94;
  return 98;
}

/** Family strength at a given size, from published coding/reasoning evals. */
const PROVIDER_BONUS: Record<string, number> = {
  qwen: 6,
  deepseek: 5,
  meta: 3,
  mistral: 3,
  google: 2,
  microsoft: 1,
};

/**
 * Recency. A 2024 7B and a 2025 7B are not the same model — training data and
 * recipe improve fast enough that generation is worth real points.
 */
const ARCH_BONUS: Record<string, number> = {
  qwen3: 5,
  "qwen2.5": 3,
  qwen2: 0,
  "llama3.3": 4,
  "llama3.2": 3,
  "llama3.1": 2,
  llama3: 0,
  "deepseek-v2": 2,
  "deepseek-r1": 4,
  "gemma3": 3,
  "gemma2": 1,
  "mistral-nemo": 2,
  phi4: 3,
};

export function fitScore(level: FitLevel): number {
  switch (level) {
    case "perfect":
      return 100;
    case "good":
      return 85;
    case "marginal":
      return 60;
    case "too_tight":
      return 30;
    case "no_fit":
      return 0;
  }
}

export function contextScore(actual: number, target: number): number {
  if (actual >= target) return 100;
  if (actual >= target / 2) return 70;
  return 30;
}

export function speedScore(tps: number, useCase: UseCase): number {
  return Math.min(100, Math.round((tps / SPEED_TARGET[useCase]) * 100));
}

/**
 * Model capability, 0–100, as served at `quant`.
 *
 * The quant multiplier is the key coupling: it means a 14B squeezed to Q3 can
 * score BELOW a 7B at Q4. That is the honest answer — a heavily-quantised big
 * model is often worse than a comfortable smaller one, and a recommender that
 * ignored this would push users toward the biggest thing that technically fits.
 */
export function qualityScore(model: CatalogModel, quant: Quant, useCase: UseCase): number {
  const base =
    paramTier(model.paramsB) +
    (PROVIDER_BONUS[model.provider] ?? 0) +
    (ARCH_BONUS[model.arch] ?? 0) +
    codingAdjustment(model, useCase);

  // QUANT_QUALITY is model-runtime's perplexity-derived table (1 = lossless) —
  // reused rather than duplicated so the two packages can't drift apart.
  const fidelity = QUANT_QUALITY[quant] ?? 0.9;
  return clamp(Math.round(base * fidelity), 0, 100);
}

/** Code-tuned models earn their keep on coding, and cost a little elsewhere. */
function codingAdjustment(model: CatalogModel, useCase: UseCase): number {
  if (useCase === "coding") return model.coding ? 8 : -2;
  // A coder model is a poor generalist — it was tuned away from open chat.
  return model.coding ? -3 : 0;
}

export interface ScoreInput {
  model: CatalogModel;
  quant: Quant;
  useCase: UseCase;
  fitLevel: FitLevel;
  context: number;
  targetContext: number;
  tps: number;
}

export interface Scored {
  score: number;
  subscores: Subscores;
}

/** The composite. Weighted sum of the four subscores, 0–100. */
export function scoreModel(input: ScoreInput): Scored {
  const subscores: Subscores = {
    quality: qualityScore(input.model, input.quant, input.useCase),
    speed: speedScore(input.tps, input.useCase),
    fit: fitScore(input.fitLevel),
    context: contextScore(input.context, input.targetContext),
  };
  const w = WEIGHTS[input.useCase];
  const score =
    subscores.quality * w.quality +
    subscores.speed * w.speed +
    subscores.fit * w.fit +
    subscores.context * w.context;

  return { score: Math.round(score * 10) / 10, subscores };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
