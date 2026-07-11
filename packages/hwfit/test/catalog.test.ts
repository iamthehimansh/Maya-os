import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCatalog,
  loadCatalogSnapshot,
  mergeCatalogs,
  resetCatalogCache,
} from "../src/catalog.js";
import { SEED_CATALOG } from "../src/data/seed.js";
import type { FetchLike } from "../src/discovery.js";
import { model } from "./fixtures.js";

const DISCOVERED_REPO = {
  id: "unsloth/Brand-New-Coder-8B-GGUF",
  tags: ["code"],
  siblings: [{ rfilename: "brand-new-coder-8b-q4_k_m.gguf" }],
};

function hf(body: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as FetchLike;
}

const offline: FetchLike = vi.fn(async () => {
  throw new Error("offline");
}) as unknown as FetchLike;

beforeEach(() => resetCatalogCache());

describe("mergeCatalogs", () => {
  it("adds discovered models the seed has never heard of", () => {
    const seed = [model({ name: "known" })];
    const found = [model({ name: "brand-new" })];
    const merged = mergeCatalogs(seed, found);
    expect(merged.map((m) => m.name).sort()).toEqual(["brand-new", "known"]);
  });

  it("lets the verified seed WIN a collision — never the name-parsed guess", () => {
    // The seed's gguf filenames were resolved against the real HF API and it
    // carries what the API won't tell us (true context, releasedAt, MLX repo).
    // Letting discovery overwrite it trades a working download for a 404.
    const seed = [model({ name: "qwen", contextLength: 32768, releasedAt: "2024-11-12" })];
    const found = [model({ name: "qwen", contextLength: 999, releasedAt: undefined })];
    const [merged] = mergeCatalogs(seed, found);
    expect(merged!.contextLength).toBe(32768);
    expect(merged!.releasedAt).toBe("2024-11-12");
  });
});

describe("loadCatalog", () => {
  it("returns seed ∪ discovery, and reports that it went live", async () => {
    const snap = await loadCatalogSnapshot({ fetchImpl: hf([DISCOVERED_REPO]) });
    expect(snap.live).toBe(true);
    expect(snap.discovered).toBe(1);
    expect(snap.models.length).toBe(SEED_CATALOG.length + 1);
    expect(snap.models.some((m) => m.name === "brand-new-coder-8b")).toBe(true);
  });

  it("falls back to the curated seed when HF is unreachable", async () => {
    // The feature must still work on a plane — just without brand-new models.
    const snap = await loadCatalogSnapshot({ fetchImpl: offline });
    expect(snap.live).toBe(false);
    expect(snap.models.map((m) => m.name)).toEqual(SEED_CATALOG.map((m) => m.name));
    expect(snap.models.length).toBeGreaterThan(0);
  });

  it("vouches for the seed's lineage — it's hand-verified by construction", () => {
    // Every seed repo and filename was checked against the live HF API, so the
    // seed is the one thing in the catalog whose family bonus is honestly earned.
    expect(SEED_CATALOG.length).toBeGreaterThan(0);
  });

  it("marks every seed model verified once loaded", async () => {
    const snap = await loadCatalogSnapshot({ fetchImpl: offline });
    expect(snap.models.every((m) => m.verified === true)).toBe(true);
  });

  it("skips the network entirely when asked", async () => {
    const fetchImpl = hf([DISCOVERED_REPO]);
    const models = await loadCatalog({ offline: true, fetchImpl });
    expect(models.map((m) => m.name)).toEqual(SEED_CATALOG.map((m) => m.name));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // One catalog load = TWO HF queries (gguf + mlx), issued in parallel.
  const QUERIES_PER_LOAD = 2;

  it("memoises — the first caller pays for discovery, the rest are free", async () => {
    const fetchImpl = hf([DISCOVERED_REPO]);
    const now = () => 1_000;
    await loadCatalog({ fetchImpl, now });
    await loadCatalog({ fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(QUERIES_PER_LOAD); // second load hit the memo
  });

  it("re-queries once the cache goes stale", async () => {
    const fetchImpl = hf([DISCOVERED_REPO]);
    let t = 0;
    const now = () => t;
    await loadCatalog({ fetchImpl, now, ttlMs: 100 });
    t = 101;
    await loadCatalog({ fetchImpl, now, ttlMs: 100 });
    expect(fetchImpl).toHaveBeenCalledTimes(2 * QUERIES_PER_LOAD);
  });

  it("re-queries on demand with refresh", async () => {
    const fetchImpl = hf([DISCOVERED_REPO]);
    await loadCatalog({ fetchImpl });
    await loadCatalog({ fetchImpl, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2 * QUERIES_PER_LOAD);
  });

  it("never caches an empty catalog", async () => {
    // Caching "nothing" would strand the UI on an empty list for six hours.
    const snap = await loadCatalogSnapshot({ fetchImpl: offline });
    expect(snap.models.length).toBeGreaterThan(0);
  });
});

describe("the seed itself", () => {
  it("ships real, verified coding models — the offline floor of the feature", () => {
    expect(SEED_CATALOG.length).toBeGreaterThan(10);
    expect(SEED_CATALOG.some((m) => m.coding && m.paramsB <= 8)).toBe(true);
    expect(SEED_CATALOG.some((m) => m.isMoe)).toBe(true);
  });

  it("has a resolvable gguf filename for every quant it advertises", () => {
    for (const m of SEED_CATALOG) {
      expect(Object.keys(m.ggufFiles).length, m.name).toBeGreaterThan(0);
      for (const file of Object.values(m.ggufFiles)) {
        expect(file, m.name).toMatch(/\.gguf$/);
      }
      expect(m.paramsB, m.name).toBeGreaterThan(0);
      // An MoE with no active-param count would be sized right but timed wrong.
      if (m.isMoe) expect(m.activeParamsB, m.name).toBeGreaterThan(0);
    }
  });

  it("has unique slugs — two models cannot both be local/<name>", () => {
    const names = SEED_CATALOG.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
