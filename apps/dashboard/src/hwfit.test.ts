import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Suggestion,
  filterSuggestions,
  fits,
  fmtCtx,
  fmtGb,
  fmtParams,
  fmtTps,
  getSuggestions,
  isRunnable,
  sortSuggestions,
  systemLabel,
} from "./hwfit";

const model = (over: Partial<Suggestion> & { name: string }): Suggestion => ({
  provider: "Qwen",
  paramsB: 7,
  isMoe: false,
  arch: "qwen2",
  fitLevel: "good",
  runMode: "gpu",
  quant: "Q4_K_M",
  context: 32768,
  requiredGb: 5,
  speedTps: 40,
  score: 80,
  subscores: { quality: 80, speed: 70, fit: 100, context: 100 },
  sources: { gguf: `hf:Qwen/${over.name}-GGUF/${over.name}-q4_k_m.gguf`, mlx: null },
  ...over,
});

describe("sortSuggestions", () => {
  it("ranks by the requested key", () => {
    const list = [
      model({ name: "a", score: 70, speedTps: 90, requiredGb: 9, paramsB: 14, context: 8192 }),
      model({ name: "b", score: 90, speedTps: 20, requiredGb: 3, paramsB: 3, context: 65536 }),
    ];
    expect(sortSuggestions(list, "score").map((m) => m.name)).toEqual(["b", "a"]);
    expect(sortSuggestions(list, "speed").map((m) => m.name)).toEqual(["a", "b"]);
    expect(sortSuggestions(list, "vram").map((m) => m.name)).toEqual(["b", "a"]); // smallest first
    expect(sortSuggestions(list, "params").map((m) => m.name)).toEqual(["a", "b"]); // largest first
    expect(sortSuggestions(list, "context").map((m) => m.name)).toEqual(["b", "a"]);
  });

  it("breaks score ties toward the newer version, deterministically", () => {
    const list = [model({ name: "qwen2-coder-7b", score: 88 }), model({ name: "qwen2.5-coder-7b", score: 88 })];
    expect(sortSuggestions(list, "score")[0]!.name).toBe("qwen2.5-coder-7b");
    // Same input in the other order must produce the same output — no shuffling
    // between renders when the scorer rates two models identically.
    expect(sortSuggestions([...list].reverse(), "score")[0]!.name).toBe("qwen2.5-coder-7b");
  });

  it("does not mutate its input", () => {
    const list = [model({ name: "a", score: 10 }), model({ name: "b", score: 99 })];
    sortSuggestions(list, "score");
    expect(list.map((m) => m.name)).toEqual(["a", "b"]);
  });
});

describe("filterSuggestions", () => {
  const list = [
    model({ name: "qwen2.5-coder-7b", provider: "Qwen", fitLevel: "perfect" }),
    model({ name: "deepseek-coder-33b", provider: "DeepSeek", arch: "deepseek2", fitLevel: "no_fit" }),
    model({ name: "mistral-7b", provider: "Mistral", arch: "llama", fitLevel: "marginal" }),
  ];

  it("fitOnly drops what the machine cannot run", () => {
    expect(filterSuggestions(list, { fitOnly: true }).map((m) => m.name)).toEqual(["qwen2.5-coder-7b", "mistral-7b"]);
  });

  it("searches name, provider and arch", () => {
    expect(filterSuggestions(list, { search: "deepseek" }).map((m) => m.name)).toEqual(["deepseek-coder-33b"]);
    expect(filterSuggestions(list, { search: "coder" })).toHaveLength(2);
    expect(filterSuggestions(list, { search: "llama" }).map((m) => m.name)).toEqual(["mistral-7b"]); // by arch
    expect(filterSuggestions(list, { search: "  QWEN " }).map((m) => m.name)).toEqual(["qwen2.5-coder-7b"]);
  });

  it("combines search with fitOnly", () => {
    expect(filterSuggestions(list, { search: "coder", fitOnly: true }).map((m) => m.name)).toEqual(["qwen2.5-coder-7b"]);
  });
});

describe("isRunnable", () => {
  it("needs a resolved .gguf — the gateway serves GGUF only", () => {
    expect(isRunnable(model({ name: "ok" }))).toBe(true);
    expect(isRunnable(model({ name: "mlx-only", sources: { gguf: null, mlx: "mlx-community/x" } }))).toBe(false);
  });

  it("is false for a model that cannot fit at all", () => {
    expect(isRunnable(model({ name: "huge", fitLevel: "no_fit" }))).toBe(false);
  });

  it("still allows a too_tight model to be run — it fits, just badly", () => {
    expect(isRunnable(model({ name: "tight", fitLevel: "too_tight" }))).toBe(true);
    expect(fits(model({ name: "tight", fitLevel: "too_tight" }))).toBe(false); // but fitOnly hides it
  });
});

describe("formatters", () => {
  it("renders human units", () => {
    expect(fmtGb(5.83)).toBe("5.8 GB");
    expect(fmtTps(42.4)).toBe("~42 tok/s");
    expect(fmtParams(7)).toBe("7B");
    expect(fmtParams(7.6)).toBe("7.6B");
    expect(fmtCtx(32768)).toBe("32K ctx");
    expect(fmtCtx(512)).toBe("512 ctx");
    expect(systemLabel({ chip: "Apple M4 Pro", backend: "metal", ramTotalGb: 16, ramAvailableGb: 9.2 })).toBe("Apple M4 Pro, 16GB");
  });
});

describe("getSuggestions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds the query and returns the envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ system: {}, results: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await getSuggestions({ useCase: "coding", limit: 24, search: "qwen", fitOnly: true });

    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://x");
    expect(url.pathname).toBe("/api/models/suggest");
    expect(url.searchParams.get("useCase")).toBe("coding");
    expect(url.searchParams.get("limit")).toBe("24");
    expect(url.searchParams.get("search")).toBe("qwen");
    expect(url.searchParams.get("fitOnly")).toBe("true");
  });

  it("omits fitOnly when false, so the server default stands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ system: {}, results: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await getSuggestions({ useCase: "chat", fitOnly: false });
    expect(fetchMock.mock.calls[0]![0]).not.toContain("fitOnly");
  });

  it("throws on a non-2xx so the view shows an error instead of rendering an error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) }));
    await expect(getSuggestions()).rejects.toThrow("HTTP 503");
  });
});
