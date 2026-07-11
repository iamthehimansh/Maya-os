/** Client + view logic for hardware-aware model recommendations ("hwfit").
 *
 * Wire shape = contract v1.1: the engine's `Recommendation` (packages/hwfit)
 * verbatim in camelCase, plus `installed` and `format` added by the gateway
 * route `GET /api/models/suggest`. This module is the dashboard's single import
 * point for it; when the client lands in `./api`, this file re-exports from
 * there and no view code moves.
 */

export type FitLevel = "perfect" | "good" | "marginal" | "too_tight" | "no_fit";
/** Where the model executes — not which artifact it is (that's `format`). */
export type RunMode = "gpu" | "hybrid" | "cpu" | "none";
export type Format = "gguf" | "mlx";

export interface Suggestion {
  name: string;
  id?: string;
  displayName?: string;
  provider: string;
  paramsB: number;
  isMoe: boolean;
  arch?: string;
  fitLevel: FitLevel;
  runMode: RunMode;
  format?: Format;
  quant: string;
  context: number;
  requiredGb: number;
  speedTps: number;
  score: number;
  subscores: { quality: number; speed: number; fit: number; context: number };
  /** `gguf` is a pull-ready `hf:owner/repo/file.gguf` with the filename resolved
   * for the chosen quant, or null when it couldn't be resolved. The gateway
   * serves GGUF only, so a null `gguf` means the pick is not runnable here. */
  sources: { gguf: string | null; mlx: string | null; hfRepo?: string };
  /** Cross-referenced against the models dir server-side. */
  installed?: boolean;
  reasons?: string[];
}

export interface SystemInfo {
  chip: string;
  backend: "metal" | "cuda" | "cpu";
  cores?: number;
  ramTotalGb: number;
  ramAvailableGb: number;
  bandwidthGbs?: number;
  platform?: string;
  arch?: string;
}

export interface SuggestResponse {
  system: SystemInfo;
  catalog?: { source: "hf+seed" | "seed"; count: number; stale?: boolean };
  useCase?: UseCase;
  results: Suggestion[];
}

export type UseCase = "coding" | "chat" | "reasoning";
export type SortBy = "score" | "speed" | "vram" | "params" | "context";

export interface SuggestOptions {
  useCase?: UseCase;
  limit?: number;
  search?: string;
  quant?: string;
  fitOnly?: boolean;
}

export const USE_CASES: UseCase[] = ["coding", "chat", "reasoning"];

export const SORTS: Array<{ key: SortBy; label: string }> = [
  { key: "score", label: "Best match" },
  { key: "speed", label: "Fastest" },
  { key: "vram", label: "Smallest" },
  { key: "params", label: "Largest" },
  { key: "context", label: "Longest context" },
];

/** Fit → badge. The label always carries the meaning; colour only reinforces it. */
export const FIT_BADGE: Record<FitLevel, { label: string; color: string; hint: string }> = {
  perfect: { label: "perfect fit", color: "var(--status-good)", hint: "runs comfortably in memory with headroom to spare" },
  good: { label: "good fit", color: "var(--status-good)", hint: "runs in memory with reasonable headroom" },
  marginal: { label: "marginal", color: "var(--status-warning)", hint: "fits, but with little headroom — expect memory pressure" },
  too_tight: { label: "too tight", color: "var(--status-serious)", hint: "only fits at a reduced context, and will be slow" },
  no_fit: { label: "won't fit", color: "var(--status-critical)", hint: "needs more memory than this machine has" },
};

const FITTING: ReadonlySet<FitLevel> = new Set<FitLevel>(["perfect", "good", "marginal"]);
export const fits = (s: Suggestion): boolean => FITTING.has(s.fitLevel);

/** The gateway pulls and serves GGUF via llama-server; there is no MLX serving
 * path. A pick with no resolved .gguf is informational, not actionable. */
export const isRunnable = (s: Suggestion): boolean => Boolean(s.sources?.gguf) && s.fitLevel !== "no_fit";

/** Trailing version in a name ("qwen2.5-coder-7b" → 2.5), for a stable,
 * newest-wins tiebreak between models the scorer rated identically. */
function version(name: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(name);
  return m ? Number.parseFloat(m[1]!) : 0;
}

const BY: Record<SortBy, (a: Suggestion, b: Suggestion) => number> = {
  score: (a, b) => b.score - a.score,
  speed: (a, b) => b.speedTps - a.speedTps,
  vram: (a, b) => a.requiredGb - b.requiredGb,
  params: (a, b) => b.paramsB - a.paramsB,
  context: (a, b) => b.context - a.context,
};

/** Sort without mutating. Ties fall back to score, then to the newer version,
 * then to the name — so equal-scoring models never shuffle between renders. */
export function sortSuggestions(list: Suggestion[], sortBy: SortBy = "score"): Suggestion[] {
  return [...list].sort(
    (a, b) =>
      BY[sortBy](a, b) ||
      b.score - a.score ||
      version(b.name) - version(a.name) ||
      a.name.localeCompare(b.name),
  );
}

/** Free-text across the fields a user would actually type: name, provider, arch, quant. */
export function filterSuggestions(list: Suggestion[], opts: { search?: string; fitOnly?: boolean } = {}): Suggestion[] {
  const q = opts.search?.trim().toLowerCase();
  return list.filter((s) => {
    if (opts.fitOnly && !fits(s)) return false;
    if (!q) return true;
    return `${s.name} ${s.displayName ?? ""} ${s.provider} ${s.arch ?? ""} ${s.quant}`.toLowerCase().includes(q);
  });
}

export const fmtGb = (n: number): string => `${n.toFixed(1)} GB`;
export const fmtTps = (n: number): string => `~${Math.round(n)} tok/s`;
export const fmtParams = (b: number): string => `${b % 1 === 0 ? b.toFixed(0) : b.toFixed(1)}B`;
export const fmtCtx = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)}K ctx` : `${n} ctx`);

/** "Apple M4 Pro, 16GB" */
export const systemLabel = (sys: SystemInfo): string => `${sys.chip}, ${Math.round(sys.ramTotalGb)}GB`;

export function getSuggestions(opts: SuggestOptions = {}, signal?: AbortSignal): Promise<SuggestResponse> {
  const q = new URLSearchParams();
  if (opts.useCase) q.set("useCase", opts.useCase);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.search) q.set("search", opts.search);
  if (opts.quant) q.set("quant", opts.quant);
  if (opts.fitOnly) q.set("fitOnly", "true");
  return fetch(`/api/models/suggest?${q}`, signal ? { signal } : {}).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<SuggestResponse>;
  });
}
