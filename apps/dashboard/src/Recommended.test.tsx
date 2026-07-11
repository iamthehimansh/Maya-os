import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, Instance } from "./api";
import { Recommended } from "./Recommended";
import type { SuggestResponse, Suggestion } from "./hwfit";

afterEach(cleanup);

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

/** himansh's machine: 16 GB unified memory, Apple Silicon. */
const SYSTEM: SuggestResponse["system"] = {
  chip: "Apple M4 Pro",
  backend: "metal",
  cores: 20,
  ramTotalGb: 16,
  ramAvailableGb: 9.2,
  bandwidthGbs: 273,
};

/** What the engine should say on a 16 GB Mac: 7B is comfortable, 14B is tight,
 * 70B cannot run at all. */
const RESULTS: Suggestion[] = [
  model({ name: "qwen2.5-coder-7b", displayName: "Qwen2.5-Coder 7B", score: 87, fitLevel: "perfect", requiredGb: 5.8, speedTps: 42, reasons: ["fits with 3.4GB headroom"] }),
  model({ name: "qwen2.5-coder-14b", displayName: "Qwen2.5-Coder 14B", score: 74, fitLevel: "marginal", paramsB: 14, requiredGb: 9.1, speedTps: 22 }),
  model({ name: "llama-3.3-70b", displayName: "Llama 3.3 70B", provider: "Meta", score: 31, fitLevel: "no_fit", paramsB: 70, requiredGb: 42, speedTps: 3, runMode: "none" }),
];

const respond = (results: Suggestion[] = RESULTS, extra: Partial<SuggestResponse> = {}) =>
  vi.fn().mockResolvedValue({ system: SYSTEM, catalog: { source: "hf+seed", count: 42 }, useCase: "coding", results, ...extra } as SuggestResponse);

const props = (over: Partial<React.ComponentProps<typeof Recommended>> = {}) => ({
  models: [] as CatalogEntry[] | null,
  live: new Map<string, Instance>(),
  busy: null,
  onPull: vi.fn(),
  onLoad: vi.fn(),
  onUnload: vi.fn(),
  fetchSuggestions: respond(),
  ...over,
});

const cards = (): HTMLElement[] => screen.getAllByRole("article");

describe("Recommended", () => {
  it("heads the panel with the detected hardware", async () => {
    render(<Recommended {...props()} />);
    expect(await screen.findByText("Recommended for your Apple M4 Pro, 16GB")).toBeTruthy();
    expect(screen.getByText(/metal · 20 cores · 9.2 GB free · 273 GB\/s/)).toBeTruthy();
  });

  it("renders the ranked models best-match first, with fit badges and specs", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText("Qwen2.5-Coder 7B");

    expect(cards().map((c) => within(c).getByText(/Qwen2.5-Coder|Llama/).textContent)).toEqual([
      "Qwen2.5-Coder 7B",
      "Qwen2.5-Coder 14B",
      "Llama 3.3 70B",
    ]);

    const top = cards()[0]!;
    expect(within(top).getByText("perfect fit")).toBeTruthy();
    expect(within(top).getByText("7B")).toBeTruthy();
    expect(within(top).getByText("Q4_K_M")).toBeTruthy();
    expect(within(top).getByText("32K ctx")).toBeTruthy();
    expect(within(top).getByText("~42 tok/s")).toBeTruthy();
    expect(within(top).getByText("5.8 GB")).toBeTruthy();
    expect(within(top).getByText("87")).toBeTruthy();
    expect(within(top).getByText("fits with 3.4GB headroom")).toBeTruthy();

    expect(within(cards()[1]!).getByText("marginal")).toBeTruthy();
    expect(within(cards()[2]!).getByText("won't fit")).toBeTruthy();
  });

  it("turns a pick into a running model: pull with the resolved gguf pinned to the slug", async () => {
    const p = props();
    render(<Recommended {...p} />);
    await screen.findByText("Qwen2.5-Coder 7B");

    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Download & serve" }));

    expect(p.onPull).toHaveBeenCalledWith(
      "hf:Qwen/qwen2.5-coder-7b-GGUF/qwen2.5-coder-7b-q4_k_m.gguf",
      "qwen2.5-coder-7b",
    );
  });

  it("offers Serve once installed, and Unload once serving", async () => {
    const installed = [{ id: "local/qwen2.5-coder-7b", displayName: "q", kind: "local-gguf" }] as CatalogEntry[];
    const p = props({ models: installed });
    const { rerender } = render(<Recommended {...p} />);
    await screen.findByText("Qwen2.5-Coder 7B");

    const top = () => cards()[0]!;
    expect(within(top()).getByText("installed")).toBeTruthy();
    fireEvent.click(within(top()).getByRole("button", { name: "Serve" }));
    expect(p.onLoad).toHaveBeenCalledWith("qwen2.5-coder-7b");

    const live = new Map<string, Instance>([["local/qwen2.5-coder-7b", { state: "ready" } as Instance]]);
    rerender(<Recommended {...p} models={installed} live={live} />);
    fireEvent.click(within(top()).getByRole("button", { name: "Unload" }));
    expect(p.onUnload).toHaveBeenCalledWith("qwen2.5-coder-7b");
  });

  it("never offers a button that cannot work: no-fit and MLX-only are info-only", async () => {
    render(
      <Recommended
        {...props({
          fetchSuggestions: respond([
            RESULTS[2]!, // no_fit
            model({ name: "mlx-only-7b", displayName: "MLX Only 7B", sources: { gguf: null, mlx: "mlx-community/x" } }),
          ]),
        })}
      />,
    );
    await screen.findByText("Llama 3.3 70B");

    expect(screen.queryByRole("button", { name: "Download & serve" })).toBeNull();
    expect(screen.getByText("needs 42.0 GB — more than this machine has")).toBeTruthy();
    expect(screen.getByText("no GGUF build — not runnable here")).toBeTruthy();
  });

  it("filters to what actually fits", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText("Llama 3.3 70B");

    fireEvent.click(screen.getByLabelText("Only models that fit", { selector: "input" }));
    await waitFor(() => expect(screen.queryByText("Llama 3.3 70B")).toBeNull());
    expect(cards()).toHaveLength(2);
  });

  it("searches, and says so when nothing matches", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText("Qwen2.5-Coder 7B");

    fireEvent.change(screen.getByLabelText("search recommendations"), { target: { value: "llama" } });
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByText("Llama 3.3 70B")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("search recommendations"), { target: { value: "gpt" } });
    await waitFor(() => expect(screen.getByText("No recommendations match those filters.")).toBeTruthy());
  });

  it("re-sorts client-side without re-querying the server", async () => {
    const p = props();
    render(<Recommended {...p} />);
    await screen.findByText("Qwen2.5-Coder 7B");

    fireEvent.change(screen.getByLabelText("sort by"), { target: { value: "vram" } });
    await waitFor(() => expect(within(cards()[0]!).getByText("Qwen2.5-Coder 7B")).toBeTruthy());
    expect(within(cards()[2]!).getByText("Llama 3.3 70B")).toBeTruthy(); // biggest last
    expect(p.fetchSuggestions).toHaveBeenCalledTimes(1);
  });

  it("re-ranks server-side when the use case changes", async () => {
    const p = props();
    render(<Recommended {...p} />);
    await screen.findByText("Qwen2.5-Coder 7B");
    expect(p.fetchSuggestions).toHaveBeenCalledWith({ useCase: "coding", limit: 24 }, expect.anything());

    fireEvent.click(screen.getByRole("radio", { name: "reasoning" }));
    await waitFor(() => expect(p.fetchSuggestions).toHaveBeenCalledWith({ useCase: "reasoning", limit: 24 }, expect.anything()));
  });

  it("flags an offline catalog rather than passing off a stale ranking as fresh", async () => {
    render(<Recommended {...props({ fetchSuggestions: respond(RESULTS, { catalog: { source: "seed", count: 8 } }) })} />);
    expect(await screen.findByText(/offline catalog/)).toBeTruthy();
  });

  it("surfaces a dead gateway instead of rendering an empty panel", async () => {
    render(<Recommended {...props({ fetchSuggestions: vi.fn().mockRejectedValue(new Error("HTTP 503")) })} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Couldn't rank models for this machine/)).toBeTruthy();
  });
});
