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
  /**
   * Whatever Node reports for this host. Deliberately NOT narrowed to
   * darwin|linux|win32: the engine assigns it straight from `process.platform`,
   * so a narrower type here would be the gateway asserting something the
   * detector cannot promise — and the only way to satisfy it would be to
   * fabricate a platform (freebsd → "linux") on the way out. Nothing branches
   * on this field; `backend` (metal|cuda|cpu) is what decides behaviour.
   */
  platform: NodeJS.Platform;
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
  /**
   * Can the engine vouch for this model's LINEAGE — is it in the curated seed,
   * or published by the upstream org itself?
   *
   * Distinct from `Suggestion.trusted`, and the pair is the whole point:
   * `trusted` = we'll accept a binary from this UPLOADER; `verified` = we know
   * who TRAINED the model. `mlx-community` is trusted and hosts a third-party
   * Gemma-4 finetune: trusted, unverified. A repo can put any family name in
   * its title but cannot forge its owner, so an unverified pick is ranked on
   * size + coding alone with no inherited family bonus.
   *
   * `verified: false` means "we can't confirm the lineage" — NOT "this is fake"
   * and NOT "this is bad". Several unverified picks are real, widely-used
   * models (DeepSeek-Coder via TheBloke; a Gemma-4 coder merge with 720k
   * downloads). The UI must word it that way or the badge cries wolf on
   * legitimate models and gets ignored on the one that matters.
   *
   * On the wire because the UI has to SAY it: a score demotion is invisible at
   * the moment of the click, and a user sorting by Fastest puts an unverified
   * model straight back on top with a working install button.
   */
  verified: boolean;
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

/** The catalog plus where it came from. See `loadCatalogSnapshot` below. */
export interface CatalogSnapshot {
  models: CatalogModel[];
  /** True when live HuggingFace discovery actually contributed models. */
  live: boolean;
}

export interface HwfitEngine {
  detectHardware(): Promise<SystemInfo>;
  loadCatalog(opts?: { refresh?: boolean }): Promise<CatalogModel[]>;
  /**
   * Preferred over `loadCatalog` when the engine offers it, because it is the
   * only honest source of `catalog.source` / `catalog.stale`.
   *
   * Discovery failure is NOT an exception: a local-first tool is expected to
   * run offline, so the engine degrades to the curated seed and resolves
   * normally. That means "loadCatalog didn't throw" says nothing about whether
   * HuggingFace was reachable — inferring liveness from it would report
   * `hf+seed` to a user on a plane. The snapshot carries the answer instead.
   */
  loadCatalogSnapshot?(opts?: { refresh?: boolean }): Promise<CatalogSnapshot>;
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
  /**
   * Is this pick's publisher one we'd hand to `pullModel`? Always true in the
   * default view (untrusted picks are withheld), so it exists for `trusted=0`:
   * the UI can then badge each unvetted card individually instead of only
   * warning globally. Served from here rather than recomputed client-side so
   * the dashboard never keeps a second copy of TRUSTED_OWNERS that can drift.
   */
  trusted: boolean;
  /** The HF account that published this artifact — "Qwen", "Jackrong", … .
   *  The one fact worth knowing before you run a stranger's binary. */
  publisher: string;
}

export interface SuggestResponse {
  system: SystemInfo;
  catalog: {
    /** "hf+seed" = live HuggingFace discovery merged in; "seed" = curated only. */
    source: "hf+seed" | "seed";
    count: number;
    /** True when we served a cached/curated catalog because discovery failed. */
    stale: boolean;
    /**
     * How many ranked picks were withheld because their HF owner isn't
     * trusted. Reported rather than silently dropped: a filter the user can't
     * see is indistinguishable from a catalog that never had the model, and
     * they need to know `trusted=0` exists.
     */
    untrustedHidden: number;
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
  /** Only offer repos from owners we'd let near `pullModel`. Default ON. */
  trusted: boolean;
  sortBy: SortBy;
  targetContext?: number;
  refresh: boolean;
}

export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 100;

/**
 * HuggingFace owners whose repos we are willing to put a one-click DOWNLOAD
 * button on.
 *
 * What this is NOT: a judgement about whether a model is real or good. An
 * earlier version of this comment asserted that `gemma-4-…` and `Qwopus3.5-…`
 * were fabricated models. That was wrong — checked against the HF API,
 * `google/gemma-4-12B-it` is a genuine Google release (2.8M downloads) and the
 * community finetune of it has 720k downloads and 2.6k likes. They were
 * unfamiliar to the author, not fictional, and "I have not heard of it" is
 * worthless as a signal in a tool whose whole job is to know about models
 * newer than whoever wrote it.
 *
 * What this IS: `Download & serve` fetches an account's binary and runs it on
 * the user's machine. For the DEFAULT view we only offer repos whose publisher
 * we can vouch for — upstream orgs and the quantisers this ecosystem runs on.
 * Everything else is one `trusted=0` away, reported via `untrustedHidden`, and
 * carries `verified` + `publisher` so the UI can say what it does and doesn't
 * know. That is an argument about PROVENANCE, which holds regardless of how
 * good or popular the model turns out to be.
 *
 * Better signals than this list exist and should outrank it — download/like
 * counts encode the world's judgement rather than one author's recognition.
 * Treat this as a floor, not a verdict.
 */
export const TRUSTED_OWNERS: readonly string[] = [
  // First-party model publishers.
  "qwen",
  "deepseek-ai",
  "meta-llama",
  "mistralai",
  "google",
  "microsoft",
  "ibm-granite",
  "allenai",
  "nvidia",
  // Quantisers the local-LLM ecosystem actually relies on.
  //
  // NOTE the limit of this axis: these accounts re-upload whatever is popular,
  // including third-party finetunes. `mlx-community` (allowlisted, rightly)
  // hosts a community Gemma-4 coder merge — so the UPLOADER is vouched for and
  // the model's lineage still isn't. Owner-trust bounds WHO hands us a binary,
  // never WHAT it is; that's `verified` (hwfit's lineage check, which no longer
  // pays a family bonus to a repo that merely *calls itself* Qwen).
  "bartowski",
  "lmstudio-community",
  "unsloth",
  "thebloke",
  "ggml-org",
  "mlx-community",
  "maziyarpanahi",
];

const ownerOf = (hfRepo: string): string => hfRepo.split("/")[0]?.toLowerCase() ?? "";

/** True when we'd be willing to hand this repo to `pullModel`. */
export const isTrustedRepo = (hfRepo: string): boolean => TRUSTED_OWNERS.includes(ownerOf(hfRepo));

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
    // Fails CLOSED: absent/garbage → trusted. Only an explicit `trusted=0`
    // (or `false`) opens the catalog up to unvetted uploaders.
    trusted: !isFalse(q["trusted"]),
    sortBy,
    ...(targetContext ? { targetContext } : {}),
    refresh: isTrue(q["refresh"]),
  };
}

const isTrue = (v: string | undefined): boolean => v === "1" || v?.toLowerCase() === "true";
const isFalse = (v: string | undefined): boolean => v === "0" || v?.toLowerCase() === "false";

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
      // Ask for provenance when the engine can give it. A resolved load does
      // NOT imply HuggingFace answered — the engine returns the curated seed
      // when it can't reach the network — so `live` has to come from the
      // engine, not from the absence of an exception.
      const load = deps.hwfit.loadCatalogSnapshot
        ? deps.hwfit.loadCatalogSnapshot({ refresh: q.refresh }).then((s) => ({ models: s.models, live: s.live }))
        : deps.hwfit.loadCatalog({ refresh: q.refresh }).then((models) => ({ models, live: true }));
      const { models, live } = await withTimeout(load, CATALOG_TIMEOUT_MS, "catalog discovery");
      cache.catalog = { value: models, at: t };
      cache.catalogStale = false;
      cache.catalogLive = live;
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

  // Withhold repos from uploaders we wouldn't hand to `pullModel`. Applied
  // AFTER ranking (the engine owns the catalog; the gateway only sees the
  // resolved picks), so a filtered page can come back shorter than `limit` —
  // acceptable, and `untrustedHidden` says so out loud.
  const kept = q.trusted ? results.filter((r) => isTrustedRepo(r.sources.hfRepo)) : results;
  const untrustedHidden = results.length - kept.length;

  const installed = deps.installedIds();
  return {
    system,
    catalog: {
      source: cache.catalogLive && !cache.catalogStale ? "hf+seed" : "seed",
      count: catalog.length,
      stale: Boolean(cache.catalogStale),
      untrustedHidden,
    },
    useCase: q.useCase,
    results: kept.map((r) => enrich(r, installed)),
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
    trusted: isTrustedRepo(r.sources.hfRepo),
    publisher: r.sources.hfRepo.split("/")[0] ?? "unknown",
  };
}
