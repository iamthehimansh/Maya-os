/**
 * @maya-ai/hwfit — the hardware-aware model recommender.
 *
 * "Suggested for your machine": detect what the user actually has, then rank
 * local models by whether they FIT and whether they'd be pleasant to RUN. Those
 * are two different questions and both matter — a 32B that technically loads at
 * 3 tok/s is not a recommendation, it's a trap.
 *
 * The shape is deliberate: all I/O is at the edges (`detectHardware`,
 * `loadCatalog`) and the ranking itself is pure and synchronous. A server
 * detects once, caches the catalog, and then ranks per request for free — and
 * the tests pin an exact machine without ever touching the host.
 *
 *   const system  = await detectHardware();
 *   const catalog = await loadCatalog();
 *   const picks   = rankModels(system, catalog, { useCase: "coding", fitOnly: true });
 */

// The engine — the three calls the gateway injects as `HwfitEngine`.
export { detectHardware, appleBandwidthGbs } from "./hardware.js";
export {
  loadCatalog,
  loadCatalogSnapshot,
  mergeCatalogs,
  mergeMlx,
  resetCatalogCache,
  type CatalogSnapshot,
  type LoadCatalogOptions,
} from "./catalog.js";
export { rankModels } from "./rank.js";

// The fit planner — exported because the runtime manager and the UI both need
// to explain *why* a model landed where it did, not just that it did.
export {
  budgetGb,
  estimateMemoryGb,
  estimateTps,
  fitLevelFor,
  planFit,
  weightBytes,
  DEFAULT_TARGET_CONTEXT,
  QUANT_BPW,
  QUANT_LADDER,
  type FitPlan,
} from "./fit.js";

// The scoring math.
export {
  contextScore,
  fitScore,
  qualityScore,
  scoreModel,
  speedScore,
  WEIGHTS,
  type Scored,
  type ScoreInput,
} from "./score.js";

// Live HuggingFace discovery — GGUF (runnable today) and MLX (Apple Silicon
// native; carried in the catalog, but not runnable until Maya grows an MLX
// backend — llamacpp.ts is GGUF-only).
export {
  discoverMlxModels,
  discoverModels,
  mlxQuantFor,
  mlxSlugFor,
  parseActiveParamsB,
  parseMlxBits,
  parseParamsB,
  resolveGgufFiles,
  slugFor,
  toCatalogModel,
  toMlxCatalogModel,
  type DiscoverOptions,
  type FetchLike,
} from "./discovery.js";

// The curated seed — usable directly when a caller wants a guaranteed-offline,
// fully-verified catalog and no network at all.
export { SEED_CATALOG } from "./data/seed.js";

export type {
  CatalogModel,
  FitLevel,
  RankOptions,
  Recommendation,
  RunMode,
  Subscores,
  SystemInfo,
  UseCase,
} from "./types.js";
