import type { ModelId, Quant } from "@maya-ai/core";

/**
 * Maya contract: the hardware-aware recommender ("hwfit").
 *
 * The question this package answers is NOT "which model is best?" — it is
 * "which models will actually fit AND run well on THIS machine?". Those are
 * different questions, and only the second one is useful to someone staring at
 * a 16 GB laptop deciding what to download.
 */

/** What we optimise for. Weights differ per use case (see score.ts). */
export type UseCase = "coding" | "chat" | "reasoning";

/** How a model would run: entirely on the accelerator, split, or not at all. */
export type RunMode = "gpu" | "hybrid" | "cpu" | "none";

/**
 * How comfortably a model fits. `too_tight` still technically fits but leaves
 * so little headroom that the runtime manager would likely degrade it, and
 * `no_fit` cannot be loaded at any context we're willing to serve.
 */
export type FitLevel = "perfect" | "good" | "marginal" | "too_tight" | "no_fit";

/** The machine we're recommending for. Produced by `detectHardware()`. */
export interface SystemInfo {
  platform: NodeJS.Platform;
  /** Human chip name, e.g. "Apple M2 Pro" / "AMD Ryzen 9 7950X". */
  chip: string;
  isAppleSilicon: boolean;
  cpuCores: number;
  /** Apple Silicon / discrete GPU core count when we can read it. */
  gpuCores?: number;
  totalRamGb: number;
  /** RAM the kernel could hand us right now (see model-runtime's `availableRam`). */
  availableRamGb: number;
  /**
   * The number that actually decides tokens/sec for a memory-bound decode:
   * every generated token streams the whole active weight set from RAM, so
   * tok/s is bounded by bandwidth ÷ model size, not by FLOPs.
   */
  memoryBandwidthGbs: number;
  backend: "metal" | "cuda" | "cpu";
  /** Discrete-GPU VRAM. Undefined on unified memory — there RAM *is* VRAM. */
  vramGb?: number;
}

/** One model we know how to fetch and run. The curated seed + HF discovery. */
export interface CatalogModel {
  /** Stable slug; installs as `local/<name>`. */
  name: string;
  displayName: string;
  /** Upstream family, e.g. "qwen" / "deepseek" / "meta". */
  provider: string;
  /** TOTAL parameters in billions — what must be resident in memory. */
  paramsB: number;
  /**
   * MoE only: parameters actually read per token. Memory is driven by
   * `paramsB` (all experts sit in RAM), speed by `activeParamsB`.
   */
  activeParamsB?: number;
  isMoe: boolean;
  /** Architecture/version tag, e.g. "qwen2.5" — drives the recency bonus. */
  arch: string;
  contextLength: number;
  /** Instruction-tuned specifically for code. */
  coding: boolean;
  /** HuggingFace GGUF repo, e.g. "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF". */
  hfRepo: string;
  /**
   * Quant → REAL filename inside `hfRepo`, verified against the HF API.
   * Filename casing is not consistent across repos (`Qwen3-8B-Q4_K_M.gguf` vs
   * `qwen2.5-coder-7b-instruct-q4_k_m.gguf`), so these are resolved, never
   * guessed — a guessed name is a download button that 404s.
   */
  ggufFiles: Partial<Record<Quant, string>>;
  /**
   * MLX repo (Apple Silicon native), when one exists. The preferred one —
   * 4-bit if published, since that's the config anyone actually runs.
   */
  mlxRepo?: string;
  /**
   * Quant → MLX repo id. Unlike GGUF (many quants in ONE repo, selected by
   * filename), MLX ships one repo PER quant
   * (`…-Instruct-MLX-4bit`, `…-MLX-8bit`), so this maps to repo ids, not files.
   *
   * MLX bit-widths are mapped onto Maya's GGUF quant ladder by nearest
   * bits-per-weight (4bit→Q4_K_M, 8bit→Q8_0…). That keeps the wire type stable
   * — `Recommendation.quant` stays a `Quant`, which the gateway and dashboard
   * both have compile-time contracts against — at the cost of a slightly
   * approximate memory estimate. The alternative was widening `quant` to a free
   * string, which would have broken both downstream layers for a rounding error.
   */
  mlxQuants?: Partial<Record<Quant, string>>;
  /** ISO date of release — the version-aware tiebreak between equal scores. */
  releasedAt?: string;
  /**
   * Whether we can vouch for this model's LINEAGE — i.e. it is what it says it
   * is. True for the curated seed, and for repos owned by the upstream org
   * itself (`Qwen/…`, `google/…`). False for anything discovered from a repo
   * whose owner is a stranger.
   *
   * This exists because `provider` and `arch` are parsed from the repo NAME,
   * and a name is a string anyone can type. `mradermacher/Qwen3-53B-TOTAL-
   * RECALL-MASTER-CODER` parses as provider=qwen, arch=qwen3 and would collect
   * Qwen's reputation bonus for calling itself Qwen; `yuxinlu1/gemma-4-12B-…`
   * collects Google's for a model Google never made ("Gemma 4" does not exist).
   * Reputation must be EARNED, not claimed — so score.ts pays the family and
   * recency bonuses only when this is true. Unverified models rank on size and
   * coding alone.
   *
   * Orthogonal to the gateway's `TRUSTED_OWNERS` gate: that one asks "whose
   * binary am I downloading" (supply chain), this one asks "do we have any
   * reason to think this model is good" (epistemic). A reputable quantizer
   * shipping a slop merge passes the first and must still fail the second.
   */
  verified?: boolean;
}

/** The four axes behind the composite score, each 0–100. */
export interface Subscores {
  quality: number;
  speed: number;
  fit: number;
  context: number;
}

/** One ranked recommendation. This is what the dashboard renders. */
export interface Recommendation {
  name: string;
  /** Precomputed so the UI can match against `GET /api/models` directly. */
  id: ModelId;
  displayName: string;
  provider: string;
  paramsB: number;
  isMoe: boolean;
  arch: string;
  fitLevel: FitLevel;
  runMode: RunMode;
  /**
   * Whether we can vouch for this model's lineage (see `CatalogModel.verified`).
   * On the wire because the UI must be able to SAY it: an unverified pick has
   * had its quality discounted for uncertainty, and the user deserves to know
   * that the number in front of them is a guess rather than a measurement.
   * Distinct from the gateway's trust gate, which is about the binary, not the
   * model.
   */
  verified: boolean;
  /** The quant we'd actually serve — one of Maya's ladder, not a free string. */
  quant: Quant;
  /** Context we could actually serve at this quant, after any halving. */
  context: number;
  /** Weights + KV + compute buffers, in GB. */
  requiredGb: number;
  /** Estimated generation throughput (tokens/sec) on this machine. */
  speedTps: number;
  score: number;
  subscores: Subscores;
  sources: {
    /**
     * Pull-ready source for Maya's gateway: `hf:owner/repo/file.gguf`, with
     * the filename resolved for `quant`. `null` when we could not resolve a
     * file for that quant — render info-only rather than a broken button.
     */
    gguf: string | null;
    mlx: string | null;
    hfRepo: string;
  };
  /** Short human explanations ("fits with 3.1 GB to spare"). */
  reasons: string[];
}

export interface RankOptions {
  useCase?: UseCase;
  limit?: number;
  /** Case-insensitive substring match over name/provider/arch. */
  search?: string;
  /** Pin a quant instead of letting the planner choose. */
  quant?: Quant;
  /** Drop anything that can't actually run (`no_fit`). */
  fitOnly?: boolean;
  sortBy?: "score" | "speed" | "vram" | "params" | "context";
  /** Context we'd like to serve. Defaults to Maya's 8192 agent floor. */
  targetContext?: number;
}
