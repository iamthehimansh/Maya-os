import { describe, expect, it } from "vitest";
import {
  WEIGHTS,
  contextScore,
  fitScore,
  qualityScore,
  scoreModel,
  speedScore,
} from "../src/score.js";
import { model } from "./fixtures.js";

describe("weights", () => {
  it("sums to 1 for every use case, so the composite stays a 0–100 scale", () => {
    for (const [useCase, w] of Object.entries(WEIGHTS)) {
      const total = w.quality + w.speed + w.fit + w.context;
      expect(total, useCase).toBeCloseTo(1, 6);
    }
  });

  it("matches the brief's coding profile, and coding is the most quality-led", () => {
    expect(WEIGHTS.coding).toEqual({ quality: 0.5, speed: 0.2, fit: 0.15, context: 0.15 });
    // Chat has a human reading along, so it trades quality for responsiveness.
    expect(WEIGHTS.chat.speed).toBeGreaterThan(WEIGHTS.coding.speed);
    expect(WEIGHTS.chat.quality).toBeLessThan(WEIGHTS.coding.quality);
  });
});

describe("subscores", () => {
  it("scores fit by band, and zeroes anything that cannot load", () => {
    expect(fitScore("perfect")).toBe(100);
    expect(fitScore("good")).toBe(85);
    expect(fitScore("marginal")).toBe(60);
    expect(fitScore("too_tight")).toBe(30);
    expect(fitScore("no_fit")).toBe(0);
  });

  it("scores context against what was asked for", () => {
    expect(contextScore(8192, 8192)).toBe(100);
    expect(contextScore(16384, 8192)).toBe(100); // more than asked is not extra credit
    expect(contextScore(4096, 8192)).toBe(70); // exactly half
    expect(contextScore(2048, 8192)).toBe(30); // a quarter — barely usable
  });

  it("saturates speed at the point more tok/s stops being felt", () => {
    expect(speedScore(30, "coding")).toBe(100);
    expect(speedScore(120, "coding")).toBe(100); // capped, not unbounded
    expect(speedScore(15, "coding")).toBe(50);
    // Chat saturates earlier (a human reads at ~10 tok/s); reasoning burns
    // hundreds of thinking tokens before it speaks, so it stays hungry longer.
    expect(speedScore(20, "chat")).toBe(100);
    expect(speedScore(20, "reasoning")).toBe(50);
  });
});

describe("qualityScore", () => {
  it("rewards size with diminishing returns — a 70B is not 10× a 7B", () => {
    const q = (paramsB: number) => qualityScore(model({ paramsB }), "Q8_0", "coding");
    expect(q(70)).toBeGreaterThan(q(14));
    expect(q(14)).toBeGreaterThan(q(7));
    // 10× the params buys well under 2× the score.
    expect(q(70)).toBeLessThan(2 * q(7));
  });

  it("discounts capability for the fidelity a quant throws away", () => {
    const m = model({ paramsB: 7 });
    const f16 = qualityScore(m, "F16", "coding");
    const q4 = qualityScore(m, "Q4_K_M", "coding");
    const q3 = qualityScore(m, "Q3_K_M", "coding");
    expect(f16).toBeGreaterThan(q4);
    expect(q4).toBeGreaterThan(q3); // monotonic down the ladder
  });

  it("still rates a 14B@Q3 above a 7B@Q4 on quality — and that is correct", () => {
    // Deliberately pinned, because it looks wrong at a glance. Down to ~Q3, a
    // bigger model at a lower quant really does beat a smaller one at a higher
    // quant. Quality is the argument FOR the big model; what stops it being
    // *recommended* on a small machine is the composite (see rank.test.ts) —
    // speed and fit outvote it there. Encoding the opposite here would be
    // scoring for a folk belief instead of for what the models actually do.
    const big = qualityScore(model({ paramsB: 14 }), "Q3_K_M", "coding");
    const small = qualityScore(model({ paramsB: 7 }), "Q4_K_M", "coding");
    expect(big).toBeGreaterThan(small);
  });

  it("prefers a code-tuned model for coding and a generalist for chat", () => {
    const coder = model({ coding: true });
    const generalist = model({ coding: false });
    expect(qualityScore(coder, "Q4_K_M", "coding")).toBeGreaterThan(
      qualityScore(generalist, "Q4_K_M", "coding"),
    );
    // ...and the coder is a worse open-chat partner: it was tuned away from it.
    expect(qualityScore(coder, "Q4_K_M", "chat")).toBeLessThan(
      qualityScore(generalist, "Q4_K_M", "chat"),
    );
  });

  it("gives newer architectures a real recency edge at equal size", () => {
    const now = qualityScore(model({ arch: "qwen3" }), "Q4_K_M", "coding");
    const then = qualityScore(model({ arch: "qwen2" }), "Q4_K_M", "coding");
    expect(now).toBeGreaterThan(then);
  });

  it("stays inside 0–100 even for an unknown provider and arch", () => {
    const weird = model({ paramsB: 405, provider: "nobody", arch: "unheard-of" });
    const q = qualityScore(weird, "F16", "coding");
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(100);
  });
});

describe("scoreModel", () => {
  const base = {
    model: model({ paramsB: 7 }),
    quant: "Q4_K_M" as const,
    useCase: "coding" as const,
    fitLevel: "perfect" as const,
    context: 8192,
    targetContext: 8192,
    tps: 30,
  };

  it("is the weighted sum of the four subscores", () => {
    const { score, subscores } = scoreModel(base);
    const w = WEIGHTS.coding;
    const expected =
      subscores.quality * w.quality +
      subscores.speed * w.speed +
      subscores.fit * w.fit +
      subscores.context * w.context;
    expect(score).toBeCloseTo(expected, 1);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("punishes a model that cannot load, however good it is", () => {
    const unloadable = scoreModel({ ...base, fitLevel: "no_fit" });
    expect(unloadable.subscores.fit).toBe(0);
    expect(unloadable.score).toBeLessThan(scoreModel(base).score);
  });

  it("weighs the same model differently per use case", () => {
    // A fast, small, code-tuned model: coding leans on its quality, chat leans
    // on its speed — so the composite must actually move between them.
    const coding = scoreModel({ ...base, useCase: "coding" }).score;
    const chat = scoreModel({ ...base, useCase: "chat" }).score;
    expect(coding).not.toBe(chat);
  });
});
