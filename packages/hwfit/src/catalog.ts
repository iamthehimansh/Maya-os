import { type FetchLike, discoverMlxModels, discoverModels } from "./discovery.js";
import { SEED_CATALOG } from "./data/seed.js";
import type { CatalogModel } from "./types.js";

/**
 * The catalog the ranker sees: the curated seed, widened by live HuggingFace
 * discovery.
 *
 * The two halves are not interchangeable. The seed is hand-verified — every
 * gguf filename in it was resolved against the real HF API, and it carries the
 * things the API will not tell us (true `contextLength`, `releasedAt`, the MLX
 * repo). Discovery is the opposite trade: current but shallow, parsed from repo
 * names. So the seed WINS every collision, and discovery may only *add* models
 * the seed has never heard of. Letting a name-parsed guess overwrite a verified
 * entry would trade a working download button for a 404.
 */

/** Six hours: new models don't land often enough to justify hammering HF. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface LoadCatalogOptions {
  /** Ignore the memo and re-query HF now. */
  refresh?: boolean;
  /** Skip the network entirely — the seed alone. */
  offline?: boolean;
  /** Discover Apple-Silicon MLX repos alongside GGUF. Default on. */
  mlx?: boolean;
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: FetchLike;
  ttlMs?: number;
  /** How many HF repos to consider. */
  limit?: number;
  /** What to ask HF for. Coding is Maya's default use case. */
  search?: string;
  /** Injected in tests — the module must not read the clock directly. */
  now?: () => number;
}

export interface CatalogSnapshot {
  models: CatalogModel[];
  /** True when live discovery actually contributed. False = seed-only (offline). */
  live: boolean;
  /** Epoch ms this snapshot was built — the gateway surfaces it as `stale`. */
  at: number;
  /** How many models discovery added on top of the seed. */
  discovered: number;
}

/**
 * Process-wide memo. Discovery costs a network round-trip and the answer is the
 * same for every caller on the machine, so the first request pays and the rest
 * are free. `refresh: true` bypasses it.
 */
let memo: CatalogSnapshot | undefined;

/** Drop the memo. Tests call this so one test's catalog can't leak into the next. */
export function resetCatalogCache(): void {
  memo = undefined;
}

/** Seed ∪ discovery, seed winning ties. Pure — the merge is separately testable. */
export function mergeCatalogs(seed: CatalogModel[], discovered: CatalogModel[]): CatalogModel[] {
  const bySlug = new Map(seed.map((m) => [m.name, m]));
  for (const model of discovered) {
    if (!bySlug.has(model.name)) bySlug.set(model.name, model);
  }
  return [...bySlug.values()];
}

/**
 * Fold MLX discoveries into a catalog. Two very different outcomes, and the
 * distinction is the whole point:
 *
 * - **Known model** → ATTACH the MLX repos to it. The model stays GGUF-runnable;
 *   it just gains an Apple-Silicon-native option. This is the real win, because
 *   MLX is meaningfully faster than GGUF on Metal.
 * - **Unknown model** → ADD it, carrying no GGUF. `sources.gguf` resolves to
 *   null, so the gateway reports `runnable: false` and the UI shows it as
 *   information rather than a Download button that Maya could not honour —
 *   `llamacpp.ts` is the only backend and it cannot load safetensors.
 *
 * The seed's own `mlxRepo` is hand-verified, so it is never overwritten by a
 * name-parsed one; discovery may only add bit-widths the seed didn't list.
 */
export function mergeMlx(base: CatalogModel[], mlx: CatalogModel[]): CatalogModel[] {
  const bySlug = new Map(base.map((m) => [m.name, m]));

  for (const found of mlx) {
    const existing = bySlug.get(found.name);
    if (!existing) {
      bySlug.set(found.name, found); // MLX-only: real information, not runnable
      continue;
    }
    // Verified seed repo wins the preferred slot; otherwise take the found one.
    // Spread conditionally rather than assigning `?? undefined` — under
    // exactOptionalPropertyTypes, "absent" and "present but undefined" differ.
    const preferred = existing.mlxRepo ?? found.mlxRepo;
    bySlug.set(found.name, {
      ...existing,
      ...(preferred ? { mlxRepo: preferred } : {}),
      mlxQuants: { ...found.mlxQuants, ...existing.mlxQuants },
    });
  }
  return [...bySlug.values()];
}

/**
 * Load the catalog, with meta. Never rejects: HF being unreachable is a normal
 * state for a local-first tool, so discovery failure degrades to the seed and
 * reports `live: false` rather than failing the request. The user on a plane
 * still gets recommendations — just not brand-new ones.
 */
export async function loadCatalogSnapshot(opts: LoadCatalogOptions = {}): Promise<CatalogSnapshot> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const t = now();

  if (!opts.refresh && memo && t - memo.at < ttl) return memo;

  // The seed is hand-verified — every repo and filename in it was checked
  // against the live HF API — so its lineage is vouched for by construction.
  const seed = SEED_CATALOG.map((m) => ({ ...m, verified: true }));
  const query = {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.search !== undefined ? { search: opts.search } : {}),
  };

  // GGUF and MLX are independent queries against HF, and either can fail on its
  // own — both already degrade to []. Run them together rather than in series:
  // this is on the request path, and one round-trip is enough to wait for.
  const [discovered, mlx] = opts.offline
    ? [[], []]
    : await Promise.all([
        discoverModels(query),
        opts.mlx === false ? Promise.resolve([]) : discoverMlxModels(query),
      ]);

  const models = mergeMlx(mergeCatalogs(seed, discovered), mlx);
  const snapshot: CatalogSnapshot = {
    models,
    live: discovered.length > 0 || mlx.length > 0,
    at: t,
    discovered: models.length - seed.length,
  };

  // Only memoise a snapshot that at least held the seed — never cache nothing.
  if (models.length) memo = snapshot;
  return snapshot;
}

/** The `HwfitEngine.loadCatalog` contract the gateway injects against. */
export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<CatalogModel[]> {
  const snapshot = await loadCatalogSnapshot(opts);
  return snapshot.models;
}
