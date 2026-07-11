/** Thin client over the gateway control API (same origin in prod; vite proxy in dev). */

export interface Instance {
  id: string;
  model: string;
  state: "starting" | "ready" | "degraded" | "unhealthy" | "stopping" | "stopped";
  port: number;
  pid: number;
  quant?: string;
  contextLength: number;
  memoryBytes: number;
  startedAt: string;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  kind: "local-gguf" | "cloud";
  contextLength?: number;
  quants?: Array<{ quant: string; quality: number; bytes: number }>;
  instance?: Instance;
  /** Measured on first load — only tool-callers are valid loop WORKERS.
   * The gateway emits this at the TOP level of each /api/models entry. */
  toolCalling?: boolean;
  /** @deprecated the gateway never emitted this nested shape — read `toolCalling`. */
  capabilities?: { toolCalling?: boolean };
}

export interface Health {
  ramFreeBytes: number;
  ramTotalBytes: number;
  instances: Instance[];
}

export type RuntimeEvent =
  | { type: "instance_state"; instanceId: string; model: string; state: Instance["state"]; reason?: string }
  | { type: "model_degraded"; model: string; from: string; to: string; reason: string }
  | { type: "instance_restarted"; instanceId: string; model: string; attempt: number }
  | { type: "ram_pressure"; freeBytes: number; action: string }
  | { type: "pull_progress"; model: string; pct: number }
  | { type: "pull_failed"; model: string; error: string };

/** GET json or throw — error bodies (e.g. the proxy's 502 {error:{…}}) must
 * surface as failures, not parse "successfully" and crash views mid-render. */
const getJson = <T>(url: string): Promise<T> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });

export const getModels = (): Promise<CatalogEntry[]> => getJson("/api/models");
export const getHealth = (): Promise<Health> => getJson("/api/runtime/health");

/** A cldz auth profile (safe view — no secrets) for the "run as" agent picker.
 * Served by the orchestrator (`GET /api/cldz/profiles`, 01's adapter reader). */
export interface CldzProfile {
  name: string;
  type: string; // "oauth" (subscription) | "apiKey" | "gateway" | …
  default: boolean;
}
export const getCldzProfiles = (): Promise<CldzProfile[]> =>
  fetch("/api/cldz/profiles")
    .then((r) => (r.ok ? (r.json() as Promise<CldzProfile[]>) : []))
    .catch(() => []);

/** Available "Run as" auth methods (native subscriptions + cldz profiles) — the
 * spawn form reads this to offer Claude/Codex-subscription options and mark ones
 * the user isn't logged into. Implemented against the orchestrator; re-exported
 * here so the setup form imports every "run as" client from one module. */
export { getAuthMethods, type AuthMethods, type CldzProfileLite } from "./orchestratorApi";

/** Real models available for a cldz profile, listed via the provider's models
 * API with that profile's credential (server-side). Empty on any error. */
export interface CloudModel {
  id: string;
  name: string;
}
export const getCloudModels = (profile: string): Promise<CloudModel[]> =>
  fetch(`/api/cloud-models?profile=${encodeURIComponent(profile)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ models?: CloudModel[] }>) : { models: [] }))
    .then((d) => d.models ?? [])
    .catch(() => []);

export const loadModel = (name: string, force = false): Promise<Response> =>
  fetch(`/api/models/${encodeURIComponent(name)}/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(force ? { force: true } : {}),
  });

export const unloadModel = (name: string): Promise<Response> =>
  fetch(`/api/models/${encodeURIComponent(name)}/unload`, { method: "POST" });

/** `name` pins the installed id to `local/<name>` (else it's derived from the
 * source filename, dots-to-dashes — which never matches curated chip names). */
export const pullModel = (source: string, name?: string): Promise<Response> =>
  fetch("/api/models/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, ...(name ? { name } : {}) }),
  });

/** Subscribe to the gateway's SSE runtime-event stream. Returns an unsubscribe. */
export function onRuntimeEvents(handler: (ev: RuntimeEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      handler(JSON.parse(m.data) as RuntimeEvent);
    } catch {
      // ignore malformed frames
    }
  };
  return () => es.close();
}

export const setModelProfile = (name: string, patch: { contextLength?: number; draftModel?: string | false }): Promise<Response> =>
  fetch(`/api/models/${encodeURIComponent(name)}/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

// ── "Suggested for your machine" (GET /api/models/suggest) ──────────────────
// Local models ranked by how well they FIT and RUN on this exact host. The
// gateway detects the hardware, scores the catalog (hwfit engine), and marks
// what's already installed. Every field is camelCase on the wire.

/** The detected machine — what the panel header renders ("your Apple M4 Pro, 16GB"). */
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

/** How well a model fits: `perfect` → runs comfortably; `no_fit` → won't load. */
export type FitLevel = "perfect" | "good" | "marginal" | "too_tight" | "no_fit";

export type UseCase = "coding" | "chat" | "reasoning";
export type SortBy = "score" | "speed" | "vram" | "params" | "context";

export interface Suggestion {
  /** Stable slug. Pin the install to it: pullModel(source, name) → local/<name>. */
  name: string;
  /** Precomputed `local/<name>` — matches ids from GET /api/models. */
  id: string;
  displayName: string;
  provider: string;
  paramsB: number;
  isMoe: boolean;
  arch: string;
  fitLevel: FitLevel;
  /** Where it executes on this host. */
  runMode: "gpu" | "hybrid" | "cpu" | "none";
  quant: string;
  context: number;
  requiredGb: number;
  /** Estimated generation speed, from this machine's memory bandwidth. */
  speedTps: number;
  score: number;
  subscores: { quality: number; speed: number; fit: number; context: number };
  /** `sources[format]` is a pull-ready `hf:owner/repo/file.gguf` — the filename
   *  resolved for the chosen quant. Null when no concrete file could be resolved. */
  sources: { gguf: string | null; mlx: string | null; hfRepo: string };
  /** Which artifact this pick is for; null → info-only card, nothing to pull. */
  format: "gguf" | "mlx" | null;
  /** Already on disk → offer Load/Unload instead of Download. */
  installed: boolean;
  /** Short human strings, e.g. "fits unified memory with 3.1GB headroom". */
  reasons: string[];
}

export interface SuggestResponse {
  system: SystemInfo;
  /** `stale` / `source: "seed"` = HuggingFace discovery failed; curated list served. */
  catalog: { source: "hf+seed" | "seed"; count: number; stale: boolean };
  useCase: UseCase;
  results: Suggestion[];
}

export interface SuggestOpts {
  useCase?: UseCase;
  limit?: number;
  search?: string;
  quant?: string;
  /** Hide models that can't actually run on this machine. */
  fitOnly?: boolean;
  sortBy?: SortBy;
  targetContext?: number;
  /** Bypass the catalog cache and re-query HuggingFace. */
  refresh?: boolean;
}

export const getSuggestions = (opts: SuggestOpts = {}): Promise<SuggestResponse> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const q = qs.toString();
  return getJson<SuggestResponse>(`/api/models/suggest${q ? `?${q}` : ""}`);
};

/**
 * Turn a recommendation into a running model: pull the resolved artifact, pinned
 * to `s.name` so it installs as `local/<name>` and matches the next listing.
 * Returns false when the card is info-only (no file resolved — nothing to pull).
 * Watch `pull_progress` on the runtime-event stream, then loadModel(s.name).
 */
export const downloadSuggestion = async (s: Suggestion): Promise<boolean> => {
  const source = s.format ? s.sources[s.format] : null;
  if (!source) return false;
  const res = await pullModel(source, s.name);
  if (!res.ok) throw new Error(`pull failed: HTTP ${res.status}`);
  return true;
};
