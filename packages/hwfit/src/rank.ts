import type { ModelId, Quant } from "@maya-ai/core";
import { DEFAULT_TARGET_CONTEXT, QUANT_LADDER, estimateTps, planFit } from "./fit.js";
import { scoreModel } from "./score.js";
import type { CatalogModel, Recommendation, RankOptions, SystemInfo } from "./types.js";

/**
 * Rank a catalog against a machine.
 *
 * Pure and synchronous by design — all the I/O (hardware probe, HF discovery)
 * happens upstream, so a server can detect + load the catalog once and then
 * rank per request for free, and tests can pin an exact machine without
 * touching the host.
 */
export function rankModels(
  system: SystemInfo,
  catalog: CatalogModel[],
  opts: RankOptions = {},
): Recommendation[] {
  const useCase = opts.useCase ?? "coding";
  const targetContext = opts.targetContext ?? DEFAULT_TARGET_CONTEXT;
  const search = opts.search?.trim().toLowerCase();

  const matched = search
    ? catalog.filter((m) =>
        [m.name, m.displayName, m.provider, m.arch].some((f) => f.toLowerCase().includes(search)),
      )
    : catalog;

  const out: Recommendation[] = [];
  for (const model of matched) {
    const best = bestConfig(model, system, useCase, targetContext, opts.quant);
    if (best) out.push(best);
  }

  const filtered = opts.fitOnly ? out.filter((r) => r.fitLevel !== "no_fit") : out;
  filtered.sort(comparator(opts.sortBy ?? "score", catalog));

  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/**
 * Search this model's (quant × context) space and keep the best configuration.
 *
 * Fitting configs always beat non-fitting ones, regardless of score. Without
 * that rule a big model at F16 could win on quality alone and be recommended
 * despite being unloadable — fit is a gate, not merely a weighted term.
 */
function bestConfig(
  model: CatalogModel,
  system: SystemInfo,
  useCase: RankOptions["useCase"] & string,
  targetContext: number,
  pinnedQuant?: Quant,
): Recommendation | null {
  const gguf = Object.keys(model.ggufFiles) as Quant[];
  const mlx = Object.keys(model.mlxQuants ?? {}) as Quant[];
  // GGUF decides the quant whenever it exists, because GGUF is what Maya can
  // actually serve today. An MLX-only model still gets planned and shown — over
  // its published bit-widths, not the whole ladder — but with a null gguf source,
  // which is what makes the gateway mark it `runnable: false` instead of
  // offering a Download that `llamacpp.ts` could never load.
  const pool = gguf.length ? gguf : mlx.length ? mlx : QUANT_LADDER;
  const quants = pinnedQuant ? pool.filter((q) => q === pinnedQuant) : pool;
  if (!quants.length) return null;

  let winner: Recommendation | null = null;
  let winnerFits = false;

  for (const quant of quants) {
    const plan = planFit(model, quant, system, targetContext);
    const tps = estimateTps(model, quant, system);
    const { score, subscores } = scoreModel({
      model,
      quant,
      useCase,
      fitLevel: plan.fitLevel,
      context: plan.context,
      targetContext,
      tps,
    });

    const fits = plan.fitLevel !== "no_fit";
    // Prefer any fitting config over any non-fitting one; break ties by score.
    if (winner && ((winnerFits && !fits) || (winnerFits === fits && score <= winner.score))) {
      continue;
    }

    const file = model.ggufFiles[quant];
    winner = {
      name: model.name,
      id: `local/${model.name}` as ModelId,
      displayName: model.displayName,
      provider: model.provider,
      paramsB: model.paramsB,
      isMoe: model.isMoe,
      arch: model.arch,
      fitLevel: plan.fitLevel,
      runMode: plan.runMode,
      // Default false: a model with no lineage claim is not vouched for. Absent
      // must never read as "fine" — that's the direction that ships slop.
      verified: model.verified === true,
      quant,
      context: plan.context,
      requiredGb: plan.requiredGb,
      speedTps: tps,
      score,
      subscores,
      sources: {
        // Pull-ready for the gateway, with the filename resolved for THIS
        // quant. Null (not a guess) when the repo has no file for it — a
        // guessed name is a download button that 404s.
        gguf: file ? `hf:${model.hfRepo}/${file}` : null,
        // MLX ships one repo PER quant, so point at the repo for the quant we
        // actually chose; fall back to the model's preferred (4-bit) repo.
        mlx: mlxRepoFor(model, quant),
        hfRepo: model.hfRepo,
      },
      reasons: explain(model, plan, tps, system),
    };
    winnerFits = fits;
  }

  return winner;
}

/** The MLX repo for this exact quant, else the model's preferred one, else null. */
function mlxRepoFor(model: CatalogModel, quant: Quant): string | null {
  const exact = model.mlxQuants?.[quant] ?? model.mlxRepo;
  return exact ? `hf:${exact}` : null;
}

/** Short, honest sentences for the card — why this landed where it did. */
function explain(
  model: CatalogModel,
  plan: ReturnType<typeof planFit>,
  tps: number,
  system: SystemInfo,
): string[] {
  const reasons: string[] = [];
  const budget = system.isAppleSilicon
    ? system.totalRamGb * 0.8
    : (system.vramGb ?? system.totalRamGb * 0.7);

  if (plan.fitLevel === "no_fit") {
    reasons.push(
      `Needs ~${plan.requiredGb} GB — more than the ~${round1(budget)} GB usable on your ${system.totalRamGb} GB machine`,
    );
  } else {
    const headroom = round1(budget - plan.requiredGb);
    reasons.push(`Needs ~${plan.requiredGb} GB at ${plan.quant} — leaves ~${headroom} GB free`);
  }

  if (plan.contextReduced) {
    reasons.push(`Context trimmed to ${plan.context} tokens to fit memory`);
  }
  if (model.isMoe) {
    reasons.push(
      `MoE: all ${model.paramsB}B live in RAM but only ~${model.activeParamsB ?? "?"}B run per token, so it punches above its speed class`,
    );
  }
  if (tps > 0) {
    reasons.push(`~${tps} tok/s estimated on ${system.chip} (${system.memoryBandwidthGbs} GB/s)`);
  }
  // Say it plainly rather than let a card imply an install it can't deliver:
  // Maya's only backend is llama.cpp (GGUF), so an MLX-only model is something
  // to know about, not something to download yet.
  if (!Object.keys(model.ggufFiles).length && model.mlxRepo) {
    reasons.push("MLX-only (Apple Silicon native) — Maya serves GGUF today, so this is info-only");
  }
  // Say the quiet part: this model's quality number is an estimate we can't back
  // with provenance, and we've discounted it for that. Better on the card than
  // buried in a scorer.
  if (model.verified !== true) {
    reasons.push(
      `Unverified upload (${model.hfRepo.split("/")[0]}) — quality is an estimate, scored conservatively`,
    );
  }
  return reasons;
}

/**
 * Sorting. The score tiebreak is version-aware: when two models score the
 * same, the newer release wins — a 2025 7B beats a 2024 7B every time.
 */
function comparator(
  sortBy: NonNullable<RankOptions["sortBy"]>,
  catalog: CatalogModel[],
): (a: Recommendation, b: Recommendation) => number {
  const released = new Map(catalog.map((m) => [m.name, m.releasedAt ?? ""]));

  return (a, b) => {
    switch (sortBy) {
      case "speed":
        return b.speedTps - a.speedTps;
      case "vram":
        // Ascending: "what's the lightest thing that works?"
        return a.requiredGb - b.requiredGb;
      case "params":
        return b.paramsB - a.paramsB;
      case "context":
        return b.context - a.context;
      case "score":
      default:
        return (
          b.score - a.score ||
          (released.get(b.name) ?? "").localeCompare(released.get(a.name) ?? "") ||
          b.paramsB - a.paramsB
        );
    }
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
