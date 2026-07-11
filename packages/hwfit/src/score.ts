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

/**
 * How much of its estimated capability an UNVERIFIED model keeps.
 *
 * Not a punishment — a confidence interval. We have no evals and no provenance
 * for it, so the number is a guess, and a guess should not outrank a
 * measurement at equal size. Modest on purpose: enough that a verified model
 * wins a tie, not so much that a genuinely good new release is buried. Seeding
 * the model (which verifies its repo and filenames) removes the discount.
 */
const UNVERIFIED_CONFIDENCE = 0.9;

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
 * The quant multiplier discounts capability for fidelity lost to quantisation,
 * but it does NOT on its own out-weigh parameter count: a 14B at Q3 still
 * out-qualities a 7B at Q4, which matches practice — down to about Q3, a bigger
 * model at a lower quant generally beats a smaller one at a higher quant.
 *
 * What stops the recommender pushing users toward the biggest thing that
 * technically fits is the COMPOSITE, not this subscore: the 14B is slower
 * (fewer tok/s, more bytes per token) and tighter (worse fit band), so on a
 * 16 GB M2 Pro the 7B at Q4 wins the ranking outright. Quality is the argument
 * FOR the big model; speed and fit are the argument against, and they are
 * weighted to win when the machine is small. See rank.test.ts.
 */
export function qualityScore(model: CatalogModel, quant: Quant, useCase: UseCase): number {
  // Reputation is EARNED, not claimed.
  //
  // `provider` and `arch` are parsed from the repo NAME, and a name is a string
  // anyone can type. Paying the family and recency bonuses on an unverified
  // model means `mradermacher/Qwen3-53B-TOTAL-RECALL-MASTER-CODER` collects
  // Qwen's +6/+5 for *calling itself* Qwen, and `yuxinlu1/gemma-4-12B-…`
  // collects Google's for a model Google never made. That is how a stranger's
  // merge out-scored the real Qwen2.5-Coder 14B.
  //
  // So an unverified model ranks on what we can actually observe — its size and
  // whether it's code-tuned — and inherits nobody else's reputation. It can
  // still win; it just has to do it on its own merits.
  const vouched = model.verified === true;
  const reputation = vouched
    ? (PROVIDER_BONUS[model.provider] ?? 0) + (ARCH_BONUS[model.arch] ?? 0)
    : 0;

  const base = paramTier(model.paramsB) + reputation + codingAdjustment(model, useCase);

  // Withholding the bonus is not enough on its own, because `paramTier` treats
  // parameter count AS capability — which is only true for a model someone
  // actually trained and evaluated. `Jackrong/Qwopus3.5-9B-Coder-MTP` claims no
  // famous family (provider=community, arch=unknown), so it never had a bonus to
  // strip, and it still out-ranked verified models on size alone.
  //
  // For an unvouched model, our quality number is a GUESS: we have no evals, no
  // provenance, and no reason to believe 9B of unknown merge is worth 9B of
  // Qwen. Ranking is about expected value, so an honest estimate has to price
  // that uncertainty in — not pretend the guess is as good as a measurement.
  // The discount is deliberately modest: a genuinely good model from a new
  // uploader is under-ranked, not buried, and seeding it removes the discount.
  const confidence = vouched ? 1 : UNVERIFIED_CONFIDENCE;

  // QUANT_QUALITY is model-runtime's perplexity-derived table (1 = lossless) —
  // reused rather than duplicated so the two packages can't drift apart.
  const fidelity = QUANT_QUALITY[quant] ?? 0.9;
  return clamp(Math.round(base * fidelity * confidence), 0, 100);
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
