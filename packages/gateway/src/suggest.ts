import type { Quant } from "@maya-ai/core";

/**
 * "Suggested for your machine" — the gateway's adapter over the hwfit engine.
 *
 * The engine (@maya-ai/hwfit) owns hardware detection, the model catalog and
 * the fit/score math. This module owns the WIRE: query validation, caching,
 * the two fields the dashboard needs but the engine can't know (`installed`,
 * `format`), and the failure modes of a route that does network I/O.
 *
 * The engine arrives by injection (GatewayDeps.hwfit) rather than a static
 * import: the gateway declares only the shape it consumes, so the route is
 * unit-testable against a fake with no HuggingFace round-trip.
 */

// ── The slice of @maya-ai/hwfit the gateway consumes ────────────────────────
// Structural, so the real module satisfies it without the gateway importing it.

export interface SystemInfo {
  platform: "darwin" | "linux" | "win32";
  chip: string;
  isAppleSilicon: boolean;
  cpuCores: number;
  gpuCores?: number;
  totalRamGb: number;
  availableRamGb: number;
  memoryBandwidthGbs: number;
  backend: "metal" | "cuda" | "cpu";
  vramGb?: number;
}

export interface Recommendation {
  name: string;
  id: string;
  displayName: string;
  provider: string;
  paramsB: number;
  isMoe: boolean;
  arch: string;
  fitLevel: "perfect" | "good" | "marginal" | "too_tight" | "no_fit";
  runMode: "gpu" | "hybrid" | "cpu" | "none";
  quant: Quant;
  context: number;
  requiredGb: number;
  speedTps: number;
  score: number;
  subscores: { quality: number; speed: number; fit: number; context: number };
  sources: { gguf: string | null; mlx: string | null; hfRepo: string };
  reasons: string[];
}

export interface RankOptions {
  useCase?: UseCase;
  limit?: number;
  search?: string;
  quant?: Quant;
  fitOnly?: boolean;
  sortBy?: SortBy;
  targetContext?: number;
}

/** Opaque to the gateway — we hand the catalog straight back to rankModels. */
export type CatalogModel = unknown;

export interface HwfitEngine {
  detectHardware(): Promise<SystemInfo>;
  loadCatalog(opts?: { refresh?: boolean }): Promise<CatalogModel[]>;
  rankModels(system: SystemInfo, catalog: CatalogModel[], opts?: RankOptions): Recommendation[];
}

// ── Wire types (what the dashboard sees) ────────────────────────────────────

export const USE_CASES = ["coding", "chat", "reasoning"] as const;
export type UseCase = (typeof USE_CASES)[number];

export const SORT_BY = ["score", "speed", "vram", "params", "context"] as const;
export type SortBy = (typeof SORT_BY)[number];

const QUANTS: readonly Quant[] = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];

/** A recommendation plus the things only the gateway can answer. */
export interface Suggestion extends Recommendation {
  /** Already pulled into modelsDir → the UI offers Load/Unload, not Download. */
  installed: boolean;
  /** Which artifact this pick resolves to. Informational — check `runnable`. */
  format: "gguf" | "mlx" | null;
  /**
   * Can Maya actually pull AND serve this today? Only GGUF: llama-server is the
   * one backend, and `pullModel` rejects a repo with no .gguf outright. An
   * MLX-only pick is real information but a dead Download button — the UI must
   * render it info-only, so we say so here rather than let the click fail.
   */
  runnable: boolean;
  /** Why not, when `runnable` is false — shown on the card instead of a button. */
  notRunnableReason?: string;
}

export interface SuggestResponse {
  system: SystemInfo;
  catalog: {
    /** "hf+seed" = live HuggingFace discovery merged in; "seed" = curated only. */
    source: "hf+seed" | "seed";
    count: number;
    /** True when we served a cached/curated catalog because discovery failed. */
    stale: boolean;
  };
  useCase: UseCase;
  results: Suggestion[];
}

export interface SuggestQuery {
  useCase: UseCase;
  limit: number;
  search?: string;
  quant?: Quant;
  fitOnly: boolean;
  /** Drop picks Maya can't pull+serve today (MLX-only, unresolvable file). */
  runnableOnly: boolean;
  sortBy: SortBy;
  targetContext?: number;
  refresh: boolean;
}

export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 100;

/**
 * Validate the query string. Rejects unknown enum values rather than silently
 * falling back — a typo'd `useCase=codeing` that quietly returns chat rankings
 * is worse than a 400 that names the mistake.
 */
export function parseSuggestQuery(q: Record<string, string | undefined>): SuggestQuery | { error: string } {
  const useCase = (q["useCase"] ?? "coding") as UseCase;
  if (!USE_CASES.includes(useCase)) {
    return { error: `unknown useCase "${q["useCase"]}" (known: ${USE_CASES.join(", ")})` };
  }
  const sortBy = (q["sortBy"] ?? "score") as SortBy;
  if (!SORT_BY.includes(sortBy)) {
    return { error: `unknown sortBy "${q["sortBy"]}" (known: ${SORT_BY.join(", ")})` };
  }
  let quant: Quant | undefined;
  if (q["quant"] !== undefined && q["quant"] !== "") {
    if (!QUANTS.includes(q["quant"] as Quant)) {
      return { error: `unknown quant "${q["quant"]}" (known: ${QUANTS.join(", ")})` };
    }
    quant = q["quant"] as Quant;
  }
  // A garbage limit clamps rather than 400s — it can't produce a wrong ranking,
  // only a wrong page size, and the UI shouldn't break on a stale bookmark.
  const rawLimit = Number(q["limit"] ?? LIMIT_DEFAULT);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), LIMIT_MAX) : LIMIT_DEFAULT;

  let targetContext: number | undefined;
  const rawCtx = Number(q["targetContext"]);
  if (q["targetContext"] !== undefined && Number.isFinite(rawCtx) && rawCtx >= 512) {
    targetContext = Math.floor(rawCtx);
  }
  const search = q["search"]?.trim();

  return {
    useCase,
    limit,
    ...(search ? { search } : {}),
    ...(quant ? { quant } : {}),
    fitOnly: isTrue(q["fitOnly"]),
    runnableOnly: isTrue(q["runnableOnly"]),
    sortBy,
    ...(targetContext ? { targetContext } : {}),
    refresh: isTrue(q["refresh"]),
  };
}

const isTrue = (v: string | undefined): boolean => v === "1" || v?.toLowerCase() === "true";

// ── Caching ─────────────────────────────────────────────────────────────────
// Hardware: the static half (chip, cores, bandwidth) never changes, but
// availableRamGb is the whole point of the fit — it moves as the user opens
// Chrome. A short TTL keeps rankings honest without spawning sysctl per keystroke.
// Catalog: HuggingFace discovery is a network round-trip; cache it far longer.

const HARDWARE_TTL_MS = 5_000;
const CATALOG_TTL_MS = 30 * 60_000;
/** HF discovery must never hang the dashboard — fall back to what we have. */
const CATALOG_TIMEOUT_MS = 8_000;

interface Cached<T> {
  value: T;
  at: number;
}

export interface SuggestCache {
  hardware?: Cached<SystemInfo>;
  catalog?: Cached<CatalogModel[]>;
  /** Set when the last catalog load failed and we served the previous one. */
  catalogStale?: boolean;
  /** Whether the cached catalog came from live discovery or the curated seed. */
  catalogLive?: boolean;
}

/** One cache per gateway (createGateway owns it) — never a module singleton,
 *  so two gateways in one process can't poison each other's rankings. */
export const newSuggestCache = (): SuggestCache => ({});

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      // Don't hold the event loop open on a timer we may never need.
      if (typeof t === "object" && "unref" in t) t.unref();
    }),
  ]);

export interface SuggestDeps {
  hwfit: HwfitEngine;
  /** Model ids already installed (`local/<name>`), for the installed flag. */
  installedIds: () => Set<string>;
  /** Owned by the caller (one per gateway) — see newSuggestCache. */
  cache: SuggestCache;
  now?: () => number;
}

/**
 * Rank local models for this machine. Throws only when there is nothing
 * truthful to return (no hardware, no catalog at all); a failed *refresh* with
 * a warm cache degrades to `stale: true` rather than an error page.
 */
export async function buildSuggestions(deps: SuggestDeps, q: SuggestQuery): Promise<SuggestResponse> {
  const cache = deps.cache;
  const now = deps.now ?? Date.now;
  const t = now();

  // Hardware — cheap, local, required. No fallback: a fit computed against
  // guessed RAM is a lie, so let it 503 instead.
  let system: SystemInfo;
  if (cache.hardware && t - cache.hardware.at < HARDWARE_TTL_MS) {
    system = cache.hardware.value;
  } else {
    system = await deps.hwfit.detectHardware();
    cache.hardware = { value: system, at: t };
  }

  // Catalog — network-backed, so this is where we degrade rather than fail.
  const fresh = q.refresh || !cache.catalog || t - cache.catalog.at >= CATALOG_TTL_MS;
  if (fresh) {
    try {
      const catalog = await withTimeout(deps.hwfit.loadCatalog({ refresh: q.refresh }), CATALOG_TIMEOUT_MS, "catalog discovery");
      cache.catalog = { value: catalog, at: t };
      cache.catalogStale = false;
      cache.catalogLive = true;
    } catch (err) {
      // Offline, rate-limited, or hung. A warm cache (even the curated seed
      // from a previous load) still gives the user a real answer.
      if (!cache.catalog) throw err;
      cache.catalogStale = true;
    }
  }
  const catalog = cache.catalog?.value ?? [];

  const results = deps.hwfit.rankModels(system, catalog, {
    useCase: q.useCase,
    limit: q.limit,
    ...(q.search ? { search: q.search } : {}),
    ...(q.quant ? { quant: q.quant } : {}),
    fitOnly: q.fitOnly,
    sortBy: q.sortBy,
    ...(q.targetContext ? { targetContext: q.targetContext } : {}),
  });

  const installed = deps.installedIds();
  return {
    system,
    catalog: {
      source: cache.catalogLive && !cache.catalogStale ? "hf+seed" : "seed",
      count: catalog.length,
      stale: Boolean(cache.catalogStale),
    },
    useCase: q.useCase,
    results: results.map((r) => enrich(r, installed)),
  };
}

/**
 * Add what the engine can't know: whether the model is on this disk, and
 * whether this host can actually run it.
 *
 * Runnability is a GATEWAY fact, not a fit fact. Maya serves GGUF through
 * llama-server (the only backend), and `pullModel` resolves `.gguf` siblings
 * exclusively — it throws on a repo with none. So an MLX-only pick can be a
 * perfect *fit* and still be impossible to install. We surface that instead of
 * letting the dashboard render a button whose click is guaranteed to fail.
 */
export function enrich(r: Recommendation, installedIds: Set<string>): Suggestion {
  const format: Suggestion["format"] = r.sources.gguf ? "gguf" : r.sources.mlx ? "mlx" : null;
  const reason =
    format === null
      ? "no concrete model file could be resolved for this quant — nothing to download"
      : format === "mlx"
        ? "MLX-only — Maya serves GGUF via llama-server today, so this can't be installed yet"
        : undefined;
  return {
    ...r,
    installed: installedIds.has(r.id),
    format,
    runnable: format === "gguf",
    ...(reason ? { notRunnableReason: reason } : {}),
  };
}
