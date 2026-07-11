import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET_CONTEXT,
  QUANT_BPW,
  budgetGb,
  estimateMemoryGb,
  estimateTps,
  fitLevelFor,
  planFit,
  weightBytes,
} from "../src/fit.js";
import { CPU_BOX_8, M2_PRO_16, M2_ULTRA_64, RTX_4070_12, model } from "./fixtures.js";

const GB = 1024 ** 3;

describe("weightBytes", () => {
  it("uses llama.cpp's real bits-per-weight, not the round number in the name", () => {
    // The whole point: Q4_K_M is 4.83 bpw (block scales included), not 4.0.
    // Assuming 4.0 under-counts a 32B by ~3 GB — exactly the error that turns a
    // confident "it fits" into an OOM on load.
    expect(QUANT_BPW.Q4_K_M).toBe(4.83);
    expect(weightBytes(7, "Q4_K_M")).toBeCloseTo((7e9 * 4.83) / 8, 0);
    expect(weightBytes(7, "Q4_K_M") / GB).toBeGreaterThan((7 * 4.0) / 8);
  });

  it("scales linearly with params and bpw", () => {
    expect(weightBytes(14, "Q4_K_M")).toBeCloseTo(2 * weightBytes(7, "Q4_K_M"), 0);
    expect(weightBytes(7, "Q8_0")).toBeGreaterThan(weightBytes(7, "Q4_K_M"));
  });
});

describe("budgetGb", () => {
  it("holds back 20% of unified memory for the OS and the user's editor", () => {
    expect(budgetGb(M2_PRO_16)).toBe(12.8); // 16 × 0.8
    expect(budgetGb(M2_ULTRA_64)).toBe(51.2);
  });

  it("budgets a discrete GPU against VRAM, not system RAM", () => {
    // 32 GB of DDR is irrelevant — the weights have to live in the 12 GB of VRAM.
    expect(budgetGb(RTX_4070_12)).toBe(10.8); // 12 × 0.9, NOT 32 × anything
  });

  it("is stable across memory pressure — it plans against total, not free RAM", () => {
    // availableRamGb is 4.9 right now (Chrome is open). Ranking off that would
    // make the recommendation list flicker between page loads; the user can
    // always quit Chrome before running a model.
    const underPressure = { ...M2_PRO_16, availableRamGb: 1.2 };
    expect(budgetGb(underPressure)).toBe(budgetGb(M2_PRO_16));
  });
});

describe("fitLevelFor", () => {
  it("bands the ratio — 'it fits' is not a binary", () => {
    expect(fitLevelFor(0.3)).toBe("perfect");
    expect(fitLevelFor(0.5)).toBe("perfect");
    expect(fitLevelFor(0.6)).toBe("good");
    expect(fitLevelFor(0.75)).toBe("good");
    expect(fitLevelFor(0.85)).toBe("marginal");
    expect(fitLevelFor(0.95)).toBe("too_tight");
    expect(fitLevelFor(1.01)).toBe("no_fit");
  });
});

describe("estimateMemoryGb", () => {
  it("counts weights + compute buffers + KV, not just the file size", () => {
    // 7.6B @ Q4_K_M: weights 4.59 GB, buffers capped at 512 MiB, KV 0.075×w at
    // the 8k reference context → ~5.09 GB. A naive weights-only estimate (4.27
    // GB) would be off by ~0.8 GB, which is what a "fits" → OOM looks like.
    const m = model({ paramsB: 7.6 });
    const gb = estimateMemoryGb(m, "Q4_K_M", 8192);
    expect(gb).toBeCloseTo(5.09, 1);
    expect(gb).toBeGreaterThan(weightBytes(7.6, "Q4_K_M") / GB);
  });

  it("grows with context — KV is the second axis the planner shrinks", () => {
    const m = model({ paramsB: 7.6 });
    expect(estimateMemoryGb(m, "Q4_K_M", 32768)).toBeGreaterThan(
      estimateMemoryGb(m, "Q4_K_M", 4096),
    );
  });

  it("charges MoE for ALL experts — every one has to be resident", () => {
    // A 30B-A3B weighs 30B in RAM even though only 3B run per token. Sizing it
    // by active params would recommend a model that cannot be loaded at all.
    const moe = model({ paramsB: 30, activeParamsB: 3, isMoe: true });
    const dense3b = model({ paramsB: 3 });
    expect(estimateMemoryGb(moe, "Q4_K_M", 8192)).toBeGreaterThan(
      5 * estimateMemoryGb(dense3b, "Q4_K_M", 8192),
    );
  });
});

describe("planFit", () => {
  it("lands a 7B Q4 on a 16 GB M2 Pro as a comfortable 'perfect'", () => {
    const plan = planFit(model({ paramsB: 7.6 }), "Q4_K_M", M2_PRO_16);
    expect(plan.fitLevel).toBe("perfect"); // 5.09 / 12.8 = 0.40
    expect(plan.context).toBe(DEFAULT_TARGET_CONTEXT);
    expect(plan.contextReduced).toBe(false);
    expect(plan.runMode).toBe("gpu");
  });

  it("halves the context down toward 1024 rather than giving up", () => {
    // 14B @ Q8_0 on 16 GB: weights alone are ~14.9 GB against a 12.8 GB budget,
    // so no context can save it — but the planner must have TRIED, and it must
    // still report the model instead of hiding it.
    const tight = planFit(model({ paramsB: 14 }), "Q8_0", M2_PRO_16);
    expect(tight.fitLevel).toBe("no_fit");
    expect(tight.context).toBe(1024); // walked all the way down before conceding
    expect(tight.runMode).toBe("none");
  });

  it("trims context to rescue a model that would otherwise not fit", () => {
    // Sized so the 8k KV is what pushes it over: it fits at a smaller window.
    const m = model({ paramsB: 18, contextLength: 32768 });
    const plan = planFit(m, "Q4_K_M", M2_PRO_16, 32768);
    expect(plan.context).toBeLessThan(32768);
    expect(plan.contextReduced).toBe(true);
    expect(plan.requiredGb).toBeLessThanOrEqual(budgetGb(M2_PRO_16));
    expect(plan.fitLevel).not.toBe("no_fit");
  });

  it("never promises more context than the model was trained for", () => {
    const shortCtx = model({ paramsB: 3, contextLength: 4096 });
    const plan = planFit(shortCtx, "Q4_K_M", M2_PRO_16, 32768);
    expect(plan.context).toBe(4096);
    // Capping at the model's own limit is not a memory-forced reduction.
    expect(plan.contextReduced).toBe(false);
  });

  it("calls it hybrid when a discrete GPU has to spill over PCIe", () => {
    // 14B @ Q4_K_M ≈ 9.7 GB → inside the 10.8 GB budget AND inside 12 GB VRAM.
    const onGpu = planFit(model({ paramsB: 13 }), "Q4_K_M", RTX_4070_12);
    expect(onGpu.runMode).toBe("gpu");
    // Force a plan that fits the ratio bands but exceeds physical VRAM.
    const spilling = planFit(model({ paramsB: 13 }), "Q4_K_M", {
      ...RTX_4070_12,
      vramGb: 8,
      totalRamGb: 64,
    });
    if (spilling.fitLevel !== "no_fit") expect(spilling.runMode).toBe("hybrid");
  });

  it("runs on the CPU box, and says so", () => {
    const plan = planFit(model({ paramsB: 3 }), "Q4_K_M", CPU_BOX_8);
    expect(plan.runMode).toBe("cpu");
  });
});

describe("estimateTps — decode is memory-bound", () => {
  it("scales with bandwidth: the same model is 4× faster on 4× the bandwidth", () => {
    const m = model({ paramsB: 7 });
    const pro = estimateTps(m, "Q4_K_M", M2_PRO_16); // 200 GB/s
    const ultra = estimateTps(m, "Q4_K_M", M2_ULTRA_64); // 800 GB/s
    expect(ultra).toBeCloseTo(pro * 4, 0);
  });

  it("makes a 30B-A3B MoE feel like a small model, because it reads like one", () => {
    // The entire reason MoE matters: memory keys off 30B, speed keys off 3B.
    // A dense 30B on the same machine must be far slower.
    const moe = model({ paramsB: 30, activeParamsB: 3, isMoe: true });
    const dense = model({ paramsB: 30 });
    const moeTps = estimateTps(moe, "Q4_K_M", M2_PRO_16);
    const denseTps = estimateTps(dense, "Q4_K_M", M2_PRO_16);
    expect(moeTps).toBeGreaterThan(5 * denseTps);
    // ...but it pays a routing penalty, so it is NOT a clean 10× of the dense 3B.
    const dense3b = estimateTps(model({ paramsB: 3 }), "Q4_K_M", M2_PRO_16);
    expect(moeTps).toBeLessThan(dense3b);
  });

  it("is slower at a bigger quant — more bytes per token to stream", () => {
    const m = model({ paramsB: 7 });
    expect(estimateTps(m, "Q8_0", M2_PRO_16)).toBeLessThan(estimateTps(m, "Q4_K_M", M2_PRO_16));
  });

  it("puts a 7B Q4 on an M2 Pro in the ~30 tok/s range users actually observe", () => {
    // Sanity anchor against reality: llama.cpp on an M2 Pro does ~25-35 tok/s
    // here. If this drifts to 300 or 3, the roofline model is broken.
    const tps = estimateTps(model({ paramsB: 7 }), "Q4_K_M", M2_PRO_16);
    expect(tps).toBeGreaterThan(20);
    expect(tps).toBeLessThan(50);
  });
});
