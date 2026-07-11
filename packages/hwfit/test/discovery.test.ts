import { describe, expect, it, vi } from "vitest";
import {
  type FetchLike,
  discoverModels,
  parseActiveParamsB,
  parseParamsB,
  resolveGgufFiles,
  slugFor,
  toCatalogModel,
} from "../src/discovery.js";

/** A fake HF /api/models response. The network is never touched in this suite. */
function hfResponse(body: unknown, ok = true): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as FetchLike;
}

const QWEN_REPO = {
  id: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
  downloads: 900_000,
  tags: ["code", "gguf"],
  siblings: [
    { rfilename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf" },
    { rfilename: "qwen2.5-coder-7b-instruct-q8_0.gguf" },
    { rfilename: "README.md" },
  ],
};

describe("parseParamsB", () => {
  it("reads the size out of a repo name", () => {
    expect(parseParamsB("Qwen2.5-Coder-7B-Instruct")).toBe(7);
    expect(parseParamsB("Llama-3.3-70B-Instruct")).toBe(70);
    expect(parseParamsB("Qwen2.5-Coder-1.5B")).toBe(1.5);
  });

  it("does NOT mistake the version number for the size", () => {
    // "Qwen2.5" must not parse as 2.5B, and "Llama-3.2-3B" is a 3B, not a 3.2B.
    // Getting this wrong sizes a 7B as a 2.5B and recommends it into an OOM.
    expect(parseParamsB("Qwen2.5-Coder-7B")).toBe(7);
    expect(parseParamsB("Llama-3.2-3B-Instruct")).toBe(3);
  });

  it("returns undefined when there is no parseable size", () => {
    // No size → no memory estimate → no honest recommendation. Skip, don't guess.
    expect(parseParamsB("some-random-model")).toBeUndefined();
  });
});

describe("parseActiveParamsB", () => {
  it("reads the -A3B MoE convention", () => {
    expect(parseActiveParamsB("Qwen3-30B-A3B")).toBe(3);
    expect(parseActiveParamsB("Qwen3-Coder-30B-A3B-Instruct")).toBe(3);
  });

  it("is undefined for a dense model", () => {
    expect(parseActiveParamsB("Qwen2.5-Coder-7B-Instruct")).toBeUndefined();
  });
});

describe("resolveGgufFiles", () => {
  it("resolves the REAL filename per quant, whatever the repo's casing", () => {
    // Repos disagree: `Qwen3-8B-Q4_K_M.gguf` vs `qwen2.5-coder-7b-q4_k_m.gguf`.
    // Templating the name is how you ship a download button that 404s.
    const files = resolveGgufFiles([
      "Qwen3-8B-Q4_K_M.gguf",
      "qwen3-8b-q8_0.gguf",
      "README.md",
    ]);
    expect(files.Q4_K_M).toBe("Qwen3-8B-Q4_K_M.gguf");
    expect(files.Q8_0).toBe("qwen3-8b-q8_0.gguf");
    expect(files.Q3_K_M).toBeUndefined(); // absent, not invented
  });

  it("points a split quant at its first shard, not a random one", () => {
    const files = resolveGgufFiles([
      "model-Q4_K_M-00002-of-00003.gguf",
      "model-Q4_K_M-00001-of-00003.gguf",
    ]);
    expect(files.Q4_K_M).toBe("model-Q4_K_M-00001-of-00003.gguf");
  });
});

describe("slugFor", () => {
  it("makes a stable local/<name> slug", () => {
    expect(slugFor("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF")).toBe("qwen2.5-coder-7b");
  });
});

describe("toCatalogModel", () => {
  it("turns an HF repo into a catalog entry", () => {
    const m = toCatalogModel(QWEN_REPO)!;
    expect(m.name).toBe("qwen2.5-coder-7b");
    expect(m.paramsB).toBe(7);
    expect(m.provider).toBe("qwen");
    expect(m.arch).toBe("qwen2.5");
    expect(m.coding).toBe(true);
    expect(m.isMoe).toBe(false);
    expect(m.ggufFiles.Q4_K_M).toBe("qwen2.5-coder-7b-instruct-q4_k_m.gguf");
  });

  it("recognises an MoE from its name and keeps total ≠ active", () => {
    const m = toCatalogModel({
      id: "unsloth/Qwen3-30B-A3B-GGUF",
      siblings: [{ rfilename: "Qwen3-30B-A3B-Q4_K_M.gguf" }],
    })!;
    expect(m.isMoe).toBe(true);
    expect(m.paramsB).toBe(30); // what must be resident
    expect(m.activeParamsB).toBe(3); // what runs per token
  });

  it("rejects a repo we cannot size or cannot download", () => {
    // Both are refusals to fabricate: no size = no honest fit, no gguf = nothing to pull.
    expect(toCatalogModel({ id: "x/mystery-model", siblings: [{ rfilename: "a.gguf" }] })).toBeNull();
    expect(toCatalogModel({ id: "x/Model-7B", siblings: [{ rfilename: "README.md" }] })).toBeNull();
  });
});

describe("discoverModels — live HF discovery", () => {
  it("queries HF and returns parsed catalog models", async () => {
    const fetchImpl = hfResponse([QWEN_REPO]);
    const models = await discoverModels({ fetchImpl, search: "coder", limit: 5 });

    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe("qwen2.5-coder-7b");

    // It asked HF for what we actually want: gguf repos, most-downloaded first.
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("huggingface.co/api/models");
    expect(url).toContain("filter=gguf");
    expect(url).toContain("search=coder");
    expect(url).toContain("limit=5");
  });

  it("degrades to [] when HF is unreachable — offline is normal, not an error", async () => {
    // A local-first model recommender that breaks on a plane would be a bad joke.
    const offline: FetchLike = vi.fn(async () => {
      throw new Error("ENOTFOUND huggingface.co");
    }) as unknown as FetchLike;
    await expect(discoverModels({ fetchImpl: offline })).resolves.toEqual([]);
  });

  it("degrades to [] on a rate limit or a 5xx", async () => {
    await expect(discoverModels({ fetchImpl: hfResponse([], false) })).resolves.toEqual([]);
  });

  it("degrades to [] on a garbage body instead of throwing", async () => {
    await expect(discoverModels({ fetchImpl: hfResponse({ error: "nope" }) })).resolves.toEqual([]);
  });

  it("skips the repos it cannot trust and keeps the ones it can", async () => {
    const models = await discoverModels({
      fetchImpl: hfResponse([QWEN_REPO, { id: "x/mystery", siblings: [] }]),
    });
    expect(models).toHaveLength(1);
  });
});
