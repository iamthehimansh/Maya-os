import { describe, expect, it } from "vitest";
import { isUpstreamOwner, isVerifiedLineage, parseBaseModel, toCatalogModel } from "../src/discovery.js";
import { qualityScore } from "../src/score.js";
import { rankModels } from "../src/rank.js";
import { M2_PRO_16, model } from "./fixtures.js";

/**
 * Reputation laundering, and the fix.
 *
 * `provider` and `arch` are parsed from the repo NAME. A name is a string
 * anyone can type. So before this guard, a stranger's merge called
 * `Qwen3-53B-…-TOTAL-RECALL-v2-MASTER-CODER` parsed as provider=qwen /
 * arch=qwen3, collected Qwen's +6 family and +5 recency bonus, and out-scored
 * the REAL Qwen2.5-Coder 14B. Reputation must be EARNED, not claimed.
 *
 * Two things a repo name cannot forge, and they are what we verify instead:
 * who OWNS the repo, and what HF's own `base_model` tag says it descends from.
 *
 * A warning for whoever reads this next, because we got it wrong first:
 * "unverified" does NOT mean fake. When this guard was written, both agents on
 * this feature confidently called `google/gemma-4-12B-it` a hallucinated model —
 * it is real (2.8M downloads, released 2026-05-23), merely NEWER THAN OUR
 * TRAINING DATA. In a *model recommender*, whose whole job is to know about
 * models newer than we are, "I've never heard of it" is worth nothing. Verify
 * against the API; never against a memory. The flag means only: we cannot vouch
 * for this model's lineage — so we don't pay it a reputation bonus, and we say
 * so on the card.
 */

const SLOP_QWEN = {
  id: "mradermacher/Qwen3-53B-A3B-2507-THINKING-TOTAL-RECALL-v2-MASTER-CODER-i1-GGUF",
  tags: ["code"],
  siblings: [{ rfilename: "Qwen3-53B-TOTAL-RECALL.i1-Q4_K_M.gguf" }],
};
const REAL_QWEN = {
  id: "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF",
  tags: ["code"],
  siblings: [{ rfilename: "qwen2.5-coder-14b-instruct-q4_k_m.gguf" }],
};

describe("parseBaseModel — HF publishes the ancestry, so read it", () => {
  it("reads the qualified relation and the base repo", () => {
    expect(
      parseBaseModel(["base_model:quantized:Qwen/Qwen3-Coder-30B-A3B-Instruct", "gguf"]),
    ).toEqual({ owner: "Qwen", repo: "Qwen3-Coder-30B-A3B-Instruct", relation: "quantized" });

    expect(parseBaseModel(["base_model:adapter:Jackrong/Qwopus3.5-9B-v3.5"])).toEqual({
      owner: "Jackrong",
      repo: "Qwopus3.5-9B-v3.5",
      relation: "adapter",
    });
  });

  it("is undefined when the model declares no ancestry", () => {
    expect(parseBaseModel(["gguf", "code"])).toBeUndefined();
    expect(parseBaseModel()).toBeUndefined();
  });
});

describe("isVerifiedLineage — the fix for the false negatives", () => {
  it("verifies a straight quantization of a real upstream model", () => {
    // TheBloke / unsloth / MaziyarPanahi don't TRAIN models, they repack real
    // ones. Calling them "unverified" libelled most of the local-LLM ecosystem —
    // which is exactly what my first cut did.
    expect(
      isVerifiedLineage("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", [
        "base_model:quantized:Qwen/Qwen3-Coder-30B-A3B-Instruct",
      ]),
    ).toBe(true);
    expect(
      isVerifiedLineage("MaziyarPanahi/Yi-Coder-9B-Chat-GGUF", [
        "base_model:quantized:01-ai/Yi-Coder-9B-Chat",
      ]),
    ).toBe(true);
  });

  it("does NOT verify a MERGE that names a real model as its base", () => {
    // THE case that fooled both @api and me. `google/gemma-4-12B-it` is REAL —
    // 2.8M downloads, released 2026-05-23, newer than our training data, and we
    // both confidently called it fiction. This repo is a community remix OF it:
    // the extra words (coder / fable5 / composer2.5) are the tell that it is a
    // derivative, not a repack. The BASE is genuine; the REMIX is unvouched.
    expect(
      isVerifiedLineage("yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF", [
        "base_model:quantized:google/gemma-4-12B-it",
      ]),
    ).toBe(false);
  });

  it("does not verify an adapter/merge, however upstream its ancestor", () => {
    // Inheriting weights is not inheriting a reputation.
    expect(
      isVerifiedLineage("someone/Qwen3-8B-uncensored-GGUF", [
        "base_model:adapter:Qwen/Qwen3-8B",
      ]),
    ).toBe(false);
    expect(
      isVerifiedLineage("someone/Qwen3-8B-GGUF", ["base_model:merge:Qwen/Qwen3-8B"]),
    ).toBe(false);
  });

  it("does not verify a model whose base is its own author", () => {
    expect(
      isVerifiedLineage("Jackrong/Qwopus3.5-9B-Coder-MTP-GGUF", [
        "base_model:adapter:Jackrong/Qwopus3.5-9B-v3.5",
      ]),
    ).toBe(false);
  });

  it("still verifies the upstream org's own repo, tags or no tags", () => {
    expect(isVerifiedLineage("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF")).toBe(true);
  });

  it("sees through STACKED packaging suffixes, in any order", () => {
    // Repos pile these up however they like. A single-pass strip leaves a
    // leftover, the name match fails, and a legitimate repack gets marked
    // unverified — which is exactly what happened to lmstudio-community.
    const base = ["base_model:quantized:Qwen/Qwen3-Coder-480B-A35B-Instruct"];
    expect(
      isVerifiedLineage("lmstudio-community/Qwen3-Coder-480B-A35B-Instruct-MLX-6bit", base),
    ).toBe(true);
    expect(isVerifiedLineage("bartowski/Qwen3-Coder-480B-A35B-Instruct-i1-GGUF", base)).toBe(true);
  });
});

describe("isUpstreamOwner", () => {
  it("trusts the org that actually makes the model", () => {
    expect(isUpstreamOwner("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF")).toBe(true);
    expect(isUpstreamOwner("google/gemma-3-12b-it")).toBe(true);
    expect(isUpstreamOwner("deepseek-ai/DeepSeek-V2-Lite")).toBe(true);
  });

  it("does NOT trust a stranger, however Qwen-ish the filename", () => {
    expect(isUpstreamOwner(SLOP_QWEN.id)).toBe(false);
    expect(isUpstreamOwner("Jackrong/Qwopus3.5-9B-Coder-MTP-GGUF")).toBe(false);
    expect(isUpstreamOwner("yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF")).toBe(false);
  });

  it("does NOT trust reputable QUANTIZERS either — that's a different question", () => {
    // bartowski/TheBloke/mradermacher are prolific and safe to download from,
    // and they quantize whatever is popular, slop merges included. "This binary
    // is probably fine" is not "this model is any good".
    expect(isUpstreamOwner("bartowski/Some-Merge-7B-GGUF")).toBe(false);
    expect(isUpstreamOwner("TheBloke/Whatever-13B-GGUF")).toBe(false);
  });
});

describe("discovery marks lineage", () => {
  it("flags an upstream repo verified and a stranger's unverified", () => {
    expect(toCatalogModel(REAL_QWEN)!.verified).toBe(true);
    expect(toCatalogModel(SLOP_QWEN)!.verified).toBe(false);
  });

  it("still parses the slop's claimed family — it just won't be PAID for it", () => {
    // We keep the parse (it's useful for search), we just stop rewarding it.
    const slop = toCatalogModel(SLOP_QWEN)!;
    expect(slop.provider).toBe("qwen"); // what it CLAIMS
    expect(slop.verified).toBe(false); // what we can VOUCH for
  });
});

describe("qualityScore pays reputation only when it's earned", () => {
  it("withholds the family and recency bonus from an unverified model", () => {
    const claimed = model({ provider: "qwen", arch: "qwen3", verified: false });
    const vouched = model({ provider: "qwen", arch: "qwen3", verified: true });
    // Same size, same claimed family — the difference is whether it's really Qwen.
    expect(qualityScore(vouched, "Q4_K_M", "coding")).toBeGreaterThan(
      qualityScore(claimed, "Q4_K_M", "coding"),
    );
  });

  it("gives an unverified model exactly what it can prove: size + coding", () => {
    // No provider/arch bonus, but no invented penalty either — it can still win,
    // it just has to do it on its own merits.
    const unknown = model({ provider: "nobody", arch: "unheard-of", verified: false });
    const claimsQwen = model({ provider: "qwen", arch: "qwen3", verified: false });
    expect(qualityScore(unknown, "Q4_K_M", "coding")).toBe(
      qualityScore(claimsQwen, "Q4_K_M", "coding"),
    );
  });

  it("leaves verified seed models completely untouched", () => {
    // The regression that would hurt most: quietly re-scoring the real catalog.
    // A verified Qwen keeps every point it had before the guard existed.
    const real = model({ provider: "qwen", arch: "qwen2.5", paramsB: 7, verified: true });
    expect(qualityScore(real, "Q4_K_M", "coding")).toBe(78); // unchanged
  });
});

describe("verified is on the wire, so the UI can say it", () => {
  it("ships verified on every recommendation", () => {
    const [real] = rankModels(M2_PRO_16, [model({ verified: true })]);
    expect(real!.verified).toBe(true);

    const [slop] = rankModels(M2_PRO_16, [toCatalogModel(SLOP_QWEN)!]);
    expect(slop!.verified).toBe(false);
  });

  it("defaults to NOT verified when lineage is absent", () => {
    // Absent must never read as "fine" — that's the direction that ships slop.
    const noClaim = { ...model(), verified: undefined };
    const [pick] = rankModels(M2_PRO_16, [noClaim]);
    expect(pick!.verified).toBe(false);
  });

  it("names the uploader in the card copy, and admits the score is an estimate", () => {
    const [slop] = rankModels(M2_PRO_16, [toCatalogModel(SLOP_QWEN)!]);
    const reasons = slop!.reasons.join(" ");
    expect(reasons).toMatch(/unverified/i);
    expect(reasons).toMatch(/mradermacher/); // who actually uploaded it
    expect(reasons).toMatch(/estimate/i);
  });

  it("says nothing of the sort about a model we CAN vouch for", () => {
    const [real] = rankModels(M2_PRO_16, [model({ verified: true })]);
    expect(real!.reasons.join(" ")).not.toMatch(/unverified/i);
  });
});

describe("the actual regression: slop out-ranking a real model", () => {
  it("no longer lets a stranger's 'MASTER-CODER' merge beat the real Qwen coder", () => {
    const slop = toCatalogModel(SLOP_QWEN)!;
    const real = toCatalogModel(REAL_QWEN)!;

    // Give the slop every advantage it had: it's BIGGER (53B vs 14B) and it
    // claims to be a Qwen3 coder. It should still lose to the genuine article
    // on a machine where neither is comfortable, because it can no longer
    // borrow Qwen's reputation — and it can't hide that it doesn't fit.
    const picks = rankModels(M2_PRO_16, [slop, real], { useCase: "coding" });
    expect(picks[0]!.name).toBe(real.name);

    const slopPick = picks.find((p) => p.name === slop.name)!;
    expect(slopPick.fitLevel).toBe("no_fit"); // 53B on a 16GB laptop
  });

  it("strips the borrowed bonus even when the slop is the same size as the real model", () => {
    // The size difference isn't doing the work — the lineage guard is.
    const slop = { ...toCatalogModel(SLOP_QWEN)!, paramsB: 14, name: "slop-14b" };
    const real = { ...toCatalogModel(REAL_QWEN)!, paramsB: 14, name: "real-14b" };
    expect(qualityScore(real, "Q4_K_M", "coding")).toBeGreaterThan(
      qualityScore(slop, "Q4_K_M", "coding"),
    );
  });
});
