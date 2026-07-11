import { describe, expect, it } from "vitest";
import { appleBandwidthGbs } from "../src/hardware.js";
import { rankModels } from "../src/rank.js";
import { SEED_CATALOG } from "../src/data/seed.js";
import { M2_PRO_16, M2_ULTRA_64, RTX_4070_12, model } from "./fixtures.js";

describe("appleBandwidthGbs", () => {
  it("knows the published figures — the constant that decides tok/s", () => {
    expect(appleBandwidthGbs("Apple M2 Pro")).toBe(200);
    expect(appleBandwidthGbs("Apple M1")).toBe(68);
    expect(appleBandwidthGbs("Apple M2 Ultra")).toBe(800);
    expect(appleBandwidthGbs("Apple M4 Pro")).toBe(273);
  });

  it("is case- and prefix-insensitive, because sysctl's string isn't stable", () => {
    expect(appleBandwidthGbs("apple m2 max")).toBe(400);
    expect(appleBandwidthGbs("M2 Max")).toBe(400);
  });

  it("uses GPU cores to tell the two Max bins apart", () => {
    // Apple ships "M4 Max" at two memory configs and the cheaper bin is ~25%
    // slower. Same name, different machine — GPU-core count is the only tell.
    expect(appleBandwidthGbs("Apple M4 Max", 32)).toBe(410);
    expect(appleBandwidthGbs("Apple M4 Max", 40)).toBe(546);
    expect(appleBandwidthGbs("Apple M3 Max", 30)).toBe(300);
    expect(appleBandwidthGbs("Apple M3 Max", 40)).toBe(400);
  });

  it("falls back on GPU cores for a chip it has never heard of", () => {
    // An M6 will ship and this table won't know it. Degrade, don't crash.
    expect(appleBandwidthGbs("Apple M6 Max", 40)).toBe(400);
    expect(appleBandwidthGbs("Apple M6")).toBe(100);
  });
});

describe("rankModels", () => {
  it("recommends a 7B coder at Q4/Q5 on a 16 GB M2 Pro, and it fits comfortably", () => {
    // The brief's definition of done, asserted against the real seed catalog.
    const picks = rankModels(M2_PRO_16, SEED_CATALOG, { useCase: "coding", limit: 5 });
    expect(picks.length).toBe(5);

    const top = picks[0]!;
    expect(top.name).toContain("coder");
    expect(top.paramsB).toBeLessThan(16); // not a 70B on a 16 GB laptop
    expect(["perfect", "good"]).toContain(top.fitLevel);
    expect(top.requiredGb).toBeLessThan(12.8); // inside the unified-memory budget
    expect(top.speedTps).toBeGreaterThan(15); // and actually usable
    expect(top.runMode).toBe("gpu");
    expect(top.id).toBe(`local/${top.name}`);
  });

  it("flags the models that are simply too big, instead of hiding them", () => {
    // "Too big" is useful information — the user is deciding what to buy next.
    const all = rankModels(M2_PRO_16, SEED_CATALOG, { useCase: "coding" });
    const huge = all.filter((r) => r.paramsB >= 70);
    expect(huge.length).toBeGreaterThan(0);
    for (const r of huge) {
      expect(r.fitLevel).toBe("no_fit");
      expect(r.runMode).toBe("none");
      expect(r.reasons.join(" ")).toMatch(/more than the/i);
    }
  });

  it("sorts by score, best first", () => {
    const picks = rankModels(M2_PRO_16, SEED_CATALOG, { useCase: "coding" });
    const scores = picks.map((p) => p.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("prefers ANY config that fits over a better-scoring one that doesn't", () => {
    // Fit is a gate, not just a weighted term. Without this rule a big model at
    // F16 could win on quality and be "recommended" while being unloadable.
    const big = model({ paramsB: 24, ggufFiles: { F16: "f16.gguf", Q3_K_M: "q3.gguf" } });
    const [pick] = rankModels(M2_PRO_16, [big]);
    expect(pick!.quant).toBe("Q3_K_M"); // the only quant that can load
    expect(pick!.fitLevel).not.toBe("no_fit");
  });

  it("drops the unloadable models when fitOnly is set", () => {
    const all = rankModels(M2_PRO_16, SEED_CATALOG, {});
    const fitted = rankModels(M2_PRO_16, SEED_CATALOG, { fitOnly: true });
    expect(fitted.length).toBeLessThan(all.length);
    expect(fitted.every((r) => r.fitLevel !== "no_fit")).toBe(true);
  });

  it("honours a pinned quant", () => {
    const picks = rankModels(M2_PRO_16, SEED_CATALOG, { quant: "Q4_K_M", fitOnly: true });
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((r) => r.quant === "Q4_K_M")).toBe(true);
  });

  it("searches name, provider and arch, case-insensitively", () => {
    const picks = rankModels(M2_PRO_16, SEED_CATALOG, { search: "DeepSeek" });
    expect(picks.length).toBeGreaterThan(0);
    expect(
      picks.every((r) => `${r.name} ${r.provider} ${r.arch}`.toLowerCase().includes("deepseek")),
    ).toBe(true);
  });

  it("supports the alternative sorts the UI exposes", () => {
    const bySpeed = rankModels(M2_PRO_16, SEED_CATALOG, { sortBy: "speed", fitOnly: true });
    expect(bySpeed[0]!.speedTps).toBeGreaterThanOrEqual(bySpeed.at(-1)!.speedTps);

    // vram sorts ASCENDING — the question is "what's the lightest thing that works?"
    const byVram = rankModels(M2_PRO_16, SEED_CATALOG, { sortBy: "vram", fitOnly: true });
    expect(byVram[0]!.requiredGb).toBeLessThanOrEqual(byVram.at(-1)!.requiredGb);

    const byParams = rankModels(M2_PRO_16, SEED_CATALOG, { sortBy: "params" });
    expect(byParams[0]!.paramsB).toBeGreaterThanOrEqual(byParams.at(-1)!.paramsB);
  });

  it("emits a pull-ready gguf source with a REAL filename, never a guess", () => {
    // A templated filename is a download button that 404s. Every source must be
    // a filename the seed actually resolved against the HF API.
    const picks = rankModels(M2_PRO_16, SEED_CATALOG, { fitOnly: true, limit: 10 });
    for (const r of picks) {
      if (!r.sources.gguf) continue;
      expect(r.sources.gguf).toMatch(/^hf:[^/]+\/[^/]+\/.+\.gguf$/);
      expect(r.sources.gguf).toContain(r.sources.hfRepo);
    }
  });

  it("returns a null gguf source — not a fabricated one — when the quant has no file", () => {
    const noFiles = model({ name: "unpublished", ggufFiles: {} });
    const [pick] = rankModels(M2_PRO_16, [noFiles]);
    expect(pick!.sources.gguf).toBeNull(); // render info-only, not a broken button
    expect(pick!.sources.hfRepo).toBe("Test/Test-7B-GGUF");
  });

  it("re-ranks for a different machine — same catalog, different answer", () => {
    // The entire premise of the feature: the recommendation is about the MACHINE.
    const onMac = rankModels(M2_PRO_16, SEED_CATALOG, { fitOnly: true });
    const onGpu = rankModels(RTX_4070_12, SEED_CATALOG, { fitOnly: true });

    // The 4070's budget is its 12 GB of VRAM (10.8 usable) — its 32 GB of system
    // RAM buys it nothing. That's a smaller budget than the Mac's 12.8 GB, so
    // anything that runs on the 4070 must also run on the Mac: a strict subset.
    const macNames = new Set(onMac.map((r) => r.name));
    expect(onGpu.length).toBeLessThanOrEqual(onMac.length);
    expect(onGpu.every((r) => macNames.has(r.name))).toBe(true);
    expect(onGpu.every((r) => r.runMode === "gpu" || r.runMode === "hybrid")).toBe(true);

    // ...and the same model is planned tighter there than on the Mac.
    const onBoth = onGpu.find((r) => macNames.has(r.name))!;
    const mac = onMac.find((r) => r.name === onBoth.name)!;
    expect(onBoth.speedTps).not.toBe(mac.speedTps); // 500 GB/s vs 200 GB/s
  });

  it("does NOT push the biggest thing that technically fits", () => {
    // The trap this whole feature exists to avoid. A 14B crushed to Q3 out-scores
    // a 7B at Q4 on QUALITY alone (83 vs 78 — and that's correct, see
    // score.test.ts). It must still lose the ranking on a 16 GB laptop, because
    // it's slower and tighter. If this ever flips, we're recommending a model
    // that will disappoint the moment the user opens a browser tab.
    const small = model({ name: "small-7b", paramsB: 7, ggufFiles: { Q4_K_M: "s.gguf" } });
    const big = model({ name: "big-14b", paramsB: 14, ggufFiles: { Q3_K_M: "b.gguf" } });

    const [winner] = rankModels(M2_PRO_16, [big, small], { useCase: "coding" });
    expect(winner!.name).toBe("small-7b");
    expect(winner!.fitLevel).toBe("perfect");

    // On a 64 GB Ultra the trade reverses — there the big model is comfortable,
    // and the extra capability is free. Same catalog, different machine.
    const [onUltra] = rankModels(M2_ULTRA_64, [big, small], { useCase: "coding" });
    expect(onUltra!.name).toBe("big-14b");
  });

  it("carries human-readable reasons for the card", () => {
    const [top] = rankModels(M2_PRO_16, SEED_CATALOG, { fitOnly: true });
    expect(top!.reasons.length).toBeGreaterThan(0);
    expect(top!.reasons.join(" ")).toMatch(/GB/);
    expect(top!.reasons.join(" ")).toMatch(/tok\/s/);
  });

  it("respects limit, and an empty catalog is empty, not a crash", () => {
    expect(rankModels(M2_PRO_16, SEED_CATALOG, { limit: 3 }).length).toBe(3);
    expect(rankModels(M2_PRO_16, [])).toEqual([]);
  });
});
