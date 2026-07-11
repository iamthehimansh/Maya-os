import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalogSnapshot, mergeMlx, resetCatalogCache } from "../src/catalog.js";
import {
  type FetchLike,
  discoverMlxModels,
  mlxQuantFor,
  mlxSlugFor,
  parseMlxBits,
  toMlxCatalogModel,
} from "../src/discovery.js";
import { rankModels } from "../src/rank.js";
import { M2_PRO_16, model } from "./fixtures.js";

/**
 * MLX is Apple Silicon's native format and it is packaged nothing like GGUF:
 * one repo PER quant (`…-MLX-4bit`, `…-MLX-8bit`), sharded safetensors, no
 * single file to point at.
 *
 * The load-bearing constraint in this whole suite: Maya's only backend is
 * `llamacpp.ts`, which is GGUF-only. So an MLX-only model must reach the user
 * as INFORMATION and never as a Download button — a button Maya could not
 * honour is worse than no button.
 */

// Real repo ids, copied from the live HF API — not invented.
const MLX_4BIT = {
  id: "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-4bit",
  tags: ["mlx", "safetensors"],
  siblings: [{ rfilename: "model-00001-of-00004.safetensors" }, { rfilename: "config.json" }],
};
const MLX_8BIT = {
  id: "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-8bit",
  tags: ["mlx", "safetensors"],
  siblings: [{ rfilename: "model-00001-of-00007.safetensors" }],
};

function hf(body: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as FetchLike;
}

beforeEach(() => resetCatalogCache());

describe("parseMlxBits", () => {
  it("reads the bit-width suffix MLX repos actually use", () => {
    expect(parseMlxBits("Qwen3-Coder-30B-A3B-Instruct-MLX-4bit")).toBe(4);
    expect(parseMlxBits("Qwen2.5-Coder-7B-Instruct-8bit")).toBe(8);
    expect(parseMlxBits("Qwen3-Coder-Next-MLX-6bit")).toBe(6);
    expect(parseMlxBits("Mistral-7B-Instruct-bf16")).toBe(16);
  });

  it("is undefined when there is no bit-width to read", () => {
    expect(parseMlxBits("Qwen2.5-Coder-7B-Instruct-GGUF")).toBeUndefined();
    expect(parseMlxBits("some-model")).toBeUndefined();
  });
});

describe("mlxQuantFor", () => {
  it("maps MLX bit-widths onto Maya's quant ladder by nearest bits-per-weight", () => {
    // Deliberate: it keeps `Recommendation.quant` a `Quant`, which the gateway
    // and the dashboard both hold compile-time contracts against. Widening the
    // wire type to a free string would have broken both layers for a rounding
    // error in the memory estimate.
    expect(mlxQuantFor(4)).toBe("Q4_K_M");
    expect(mlxQuantFor(8)).toBe("Q8_0");
    expect(mlxQuantFor(6)).toBe("Q6_K");
    expect(mlxQuantFor(16)).toBe("F16");
    expect(mlxQuantFor(7)).toBeUndefined(); // no such MLX build; don't invent one
  });
});

describe("mlxSlugFor", () => {
  it("collides ON PURPOSE with the GGUF slug for the same model", () => {
    // This collision is the entire mechanism: it's what lets an MLX repo ATTACH
    // to the model the user can already download, instead of listing it twice.
    expect(mlxSlugFor("mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")).toBe("qwen2.5-coder-7b");
    expect(mlxSlugFor("lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-8bit")).toBe(
      "qwen3-coder-30b-a3b",
    );
  });
});

describe("toMlxCatalogModel", () => {
  it("builds an entry that carries NO gguf — the thing that makes it non-runnable", () => {
    const m = toMlxCatalogModel(MLX_4BIT)!;
    expect(m.ggufFiles).toEqual({}); // ← llamacpp can't load safetensors
    expect(m.mlxRepo).toBe(MLX_4BIT.id);
    expect(m.mlxQuants).toEqual({ Q4_K_M: MLX_4BIT.id });
    expect(m.paramsB).toBe(30);
    expect(m.isMoe).toBe(true);
    expect(m.activeParamsB).toBe(3);
    expect(m.coding).toBe(true);
  });

  it("keeps the bit-width OUT of the display name", () => {
    // The card shows the quant in its own field, and it may not even be the
    // bit-width of this particular repo — so "Qwen3 Coder 30B A3B 8bit" on the
    // card next to "Q4_K_M" would be doubly wrong. Note plenty of repos end in
    // `-8bit` with no `MLX` in the name at all.
    expect(toMlxCatalogModel(MLX_8BIT)!.displayName).not.toMatch(/bit/i);
    expect(toMlxCatalogModel(MLX_8BIT)!.displayName).not.toMatch(/mlx/i);
    expect(
      toMlxCatalogModel({ id: "mlx-community/Qwen2.5-Coder-7B-Instruct-8bit" })!.displayName,
    ).not.toMatch(/bit/i);
  });

  it("refuses a repo it cannot size or cannot read a bit-width from", () => {
    expect(toMlxCatalogModel({ id: "mlx-community/Mystery-4bit" })).toBeNull(); // no size
    expect(toMlxCatalogModel({ id: "mlx-community/Qwen-7B" })).toBeNull(); // no bit-width
  });
});

describe("discoverMlxModels", () => {
  it("folds the per-quant repos of one model into ONE entry", async () => {
    // 4bit and 8bit are two repos describing one model. Returning both would
    // show the user the same model twice.
    const models = await discoverMlxModels({ fetchImpl: hf([MLX_4BIT, MLX_8BIT]) });
    expect(models).toHaveLength(1);
    expect(models[0]!.mlxQuants).toEqual({
      Q4_K_M: MLX_4BIT.id,
      Q8_0: MLX_8BIT.id,
    });
    // 4-bit is what anyone actually runs on a laptop, so it wins the slot.
    expect(models[0]!.mlxRepo).toBe(MLX_4BIT.id);
  });

  it("asks HF for mlx repos", async () => {
    const fetchImpl = hf([MLX_4BIT]);
    await discoverMlxModels({ fetchImpl, search: "coder" });
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("filter=mlx");
    expect(url).toContain("search=coder");
  });

  it("degrades to [] offline, exactly like GGUF discovery", async () => {
    const dead: FetchLike = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as FetchLike;
    await expect(discoverMlxModels({ fetchImpl: dead })).resolves.toEqual([]);
  });
});

describe("mergeMlx", () => {
  it("ATTACHES mlx to a model we can already run, without disturbing its gguf", () => {
    // The real win: the model stays GGUF-runnable and gains a faster
    // Apple-Silicon-native option.
    const base = [model({ name: "qwen2.5-coder-7b" })];
    const found = [
      { ...model({ name: "qwen2.5-coder-7b" }), ggufFiles: {}, mlxQuants: { Q4_K_M: "mlx/x-4bit" } },
    ];
    const [merged] = mergeMlx(base, found);
    expect(Object.keys(merged!.ggufFiles).length).toBeGreaterThan(0); // still runnable
    expect(merged!.mlxQuants).toEqual({ Q4_K_M: "mlx/x-4bit" });
  });

  it("never lets a name-parsed mlx repo overwrite the hand-verified seed one", () => {
    const base = [model({ name: "m", mlxRepo: "mlx-community/verified-4bit" })];
    const found = [{ ...model({ name: "m" }), mlxRepo: "someone/guessed-4bit" }];
    const [merged] = mergeMlx(base, found);
    expect(merged!.mlxRepo).toBe("mlx-community/verified-4bit");
  });

  it("adds an MLX-only model as a new, gguf-less entry", () => {
    const found = [toMlxCatalogModel(MLX_4BIT)!];
    const merged = mergeMlx([], found);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ggufFiles).toEqual({});
  });
});

describe("ranking an MLX-only model — the dead-button guard", () => {
  const mlxOnly = toMlxCatalogModel({
    ...MLX_4BIT,
    id: "lmstudio-community/Qwen3-Coder-7B-Instruct-MLX-4bit",
  })!;

  it("emits a NULL gguf source, which is what makes the gateway say runnable:false", () => {
    const [pick] = rankModels(M2_PRO_16, [mlxOnly]);
    expect(pick!.sources.gguf).toBeNull(); // ← no Download button Maya can't honour
    expect(pick!.sources.mlx).toBe("hf:lmstudio-community/Qwen3-Coder-7B-Instruct-MLX-4bit");
  });

  it("plans it over its PUBLISHED bit-widths, not the whole gguf ladder", () => {
    // It only ships 4-bit, so Q4_K_M is the only quant we may reason about.
    // Reasoning over F16 would invent a config that does not exist.
    const [pick] = rankModels(M2_PRO_16, [mlxOnly]);
    expect(pick!.quant).toBe("Q4_K_M");
  });

  it("tells the user, in words, that it cannot be installed yet", () => {
    const [pick] = rankModels(M2_PRO_16, [mlxOnly]);
    expect(pick!.reasons.join(" ")).toMatch(/MLX-only/i);
    expect(pick!.reasons.join(" ")).toMatch(/info-only/i);
  });

  it("still resolves a REAL gguf source for a model that has both", () => {
    // Attaching MLX must not cost a runnable model its Download button.
    const both = { ...model({ name: "both" }), mlxQuants: { Q4_K_M: "mlx/both-4bit" } };
    const [pick] = rankModels(M2_PRO_16, [both], { quant: "Q4_K_M" });
    expect(pick!.sources.gguf).toBe("hf:Test/Test-7B-GGUF/test-7b-q4_k_m.gguf");
    expect(pick!.sources.mlx).toBe("hf:mlx/both-4bit");
  });
});

describe("loadCatalog with MLX", () => {
  it("merges GGUF and MLX discovery in one snapshot", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("filter=mlx") ? [MLX_4BIT] : []), { status: 200 }),
    ) as unknown as FetchLike;

    const snap = await loadCatalogSnapshot({ fetchImpl });
    expect(snap.live).toBe(true); // MLX alone is enough to count as live
    expect(snap.models.some((m) => m.name === "qwen3-coder-30b-a3b")).toBe(true);
  });

  it("can be turned off without turning off GGUF discovery", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    ) as unknown as FetchLike;

    await loadCatalogSnapshot({ fetchImpl, mlx: false });
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls.some((u) => String(u).includes("filter=gguf"))).toBe(true);
    expect(urls.some((u) => String(u).includes("filter=mlx"))).toBe(false);
  });
});
