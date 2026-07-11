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
  /** `null` when no artifact resolved for the chosen quant — the gateway sends
   * the key regardless, so the view must be able to hold the null. */
  format?: Format | null;
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
  /** False = discovered on HF with no verified lineage: it is not in the curated
   * seed, and the repo owner is not the upstream org. The engine already refuses
   * to pay it reputation bonuses (score.ts), but a demoted model is still a
   * *visible* model — and once its uploader is allowlisted it gets a working
   * Download button. So the card must say so. Absent = the server doesn't send
   * it yet; we badge nothing rather than guess. */
  verified?: boolean;
  /** Cross-referenced against the models dir server-side. */
  installed?: boolean;
  /** The gateway's verdict on "can Maya pull AND serve this today?" — it knows
   * what `pullModel` will accept, so it outranks our client-side guess. */
  runnable?: boolean;
  notRunnableReason?: string;
  reasons?: string[];
}

/** Field-for-field the engine's `SystemInfo` (packages/hwfit/src/types.ts): the
 * gateway puts it on the wire verbatim, so any rename here silently breaks the
 * header. `hwfit.contract.test.ts` makes tsc enforce that. */
export interface SystemInfo {
  platform?: string;
  chip: string;
  isAppleSilicon?: boolean;
  cpuCores: number;
  gpuCores?: number;
  totalRamGb: number;
  availableRamGb: number;
  memoryBandwidthGbs?: number;
  backend: "metal" | "cuda" | "cpu";
  vramGb?: number;
}

export interface SuggestResponse {
  system: SystemInfo;
  catalog?: {
    source: "hf+seed" | "seed";
    count: number;
    stale?: boolean;
    /** Picks withheld because their HF owner isn't on the gateway's allowlist.
     * A filter the user can't see is a filter they can't overrule — so the panel
     * says how many vanished and offers to show them. */
    untrustedHidden?: number;
  };
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
  /** `false` asks the gateway for unvetted uploaders too (`trusted=0`). Only
   * ever set from an explicit user action — the default must stay closed. */
  trusted?: boolean;
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
 * path. A pick with no resolved .gguf is informational, not actionable.
 *
 * The gateway ships its own `runnable` — it knows what `pullModel` accepts — so
 * trust it when present and keep the local rule as the offline fallback. */
export const isRunnable = (s: Suggestion): boolean =>
  (typeof s.runnable === "boolean" ? s.runnable : Boolean(s.sources?.gguf)) && s.fitLevel !== "no_fit";

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

// A missing number is a wire-contract bug, not a user-facing crash: render "—"
// so one absent field can't take the whole Models tab down with a TypeError.
const num = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export const fmtGb = (n: number | undefined): string => (num(n) ? `${n.toFixed(1)} GB` : "—");
export const fmtTps = (n: number | undefined): string => (num(n) ? `~${Math.round(n)} tok/s` : "—");
export const fmtParams = (b: number | undefined): string => (num(b) ? `${b % 1 === 0 ? b.toFixed(0) : b.toFixed(1)}B` : "—");
export const fmtCtx = (n: number | undefined): string => (num(n) ? (n >= 1024 ? `${Math.round(n / 1024)}K ctx` : `${n} ctx`) : "—");

/** Who published the artifact this card would download — `bartowski`, `Qwen`,
 * or some anonymous account.
 *
 * "Download & serve" fetches a binary from HuggingFace and feeds it to
 * llama-server. Live discovery surfaces repos from every kind of uploader —
 * upstream orgs, career quantizers, and anonymous accounts alike — and a repo
 * NAME is not evidence of what is inside it. So the one fact a user needs
 * before clicking — *whose* binary is this — must be on the card, not one click
 * away. Note this is a provenance question, never a quality verdict: an unknown
 * owner may well be shipping something excellent. Derived from the repo the
 * server resolved; we do NOT re-implement the gateway's allowlist here, or it
 * would drift from it. */
export const publisherOf = (s: Suggestion): string | null => {
  const repo = s.sources?.hfRepo ?? s.sources?.gguf ?? s.sources?.mlx ?? null;
  if (!repo) return null;
  const owner = repo.replace(/^hf:/, "").split("/")[0];
  return owner || null;
};

/** The artifact to actually pull for a pick.
 *
 * Today the gateway only serves GGUF, so this is almost always `sources.gguf`.
 * But `format` is the server's own statement of which artifact it resolved, and
 * an MLX serving backend is planned (`RuntimeBackend` in core already spells
 * `'llama.cpp' | 'mlx'`). Selecting by `format` means the day MLX flips to
 * runnable, the Download button pulls the MLX repo instead of passing a `null`
 * gguf source — rather than this being found in production. */
export const pullSourceFor = (s: Suggestion): string | null =>
  (s.format === "mlx" ? s.sources?.mlx : s.sources?.gguf) ?? s.sources?.gguf ?? null;

/** A pick the engine says fits, but which won't load until memory is freed.
 *
 * The engine budgets against `totalRamGb` on purpose (see `fit.ts:budgetGb`) so
 * rankings stay stable — but the runtime guardrail checks memory that is free
 * *now*. Between them sits a card that says "perfect fit" and a Serve button
 * that fails with "cannot fit". This is that gap, surfaced. */
export const tightNow = (s: Suggestion, sys: SystemInfo | undefined): boolean =>
  Boolean(sys) &&
  Number.isFinite(sys!.availableRamGb) &&
  Number.isFinite(s.requiredGb) &&
  fits(s) &&
  s.requiredGb > sys!.availableRamGb;

/** "Apple M4 Pro, 16GB" */
export const systemLabel = (sys: SystemInfo): string =>
  num(sys.totalRamGb) ? `${sys.chip}, ${Math.round(sys.totalRamGb)}GB` : sys.chip;

export function getSuggestions(opts: SuggestOptions = {}, signal?: AbortSignal): Promise<SuggestResponse> {
  const q = new URLSearchParams();
  if (opts.useCase) q.set("useCase", opts.useCase);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.search) q.set("search", opts.search);
  if (opts.quant) q.set("quant", opts.quant);
  if (opts.fitOnly) q.set("fitOnly", "true");
  // Only ever sent as an explicit opt-out; omitting it leaves the gate closed.
  if (opts.trusted === false) q.set("trusted", "0");
  return fetch(`/api/models/suggest?${q}`, signal ? { signal } : {}).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<SuggestResponse>;
  });
}
