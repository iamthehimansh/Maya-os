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
  cpuCores: 20,
  totalRamGb: 16,
  availableRamGb: 9.2,
  memoryBandwidthGbs: 273,
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

  // @hwfit is adding live MLX discovery, so the gateway will start emitting
  // MLX-only picks with its own verdict (`suggest.ts:enrich()` sets
  // runnable:false + notRunnableReason). Pin that payload now: an MLX-only
  // model is real information, but its Download button would hand `pullModel` a
  // repo with no .gguf, which `download.ts` rejects outright.
  it("shows the gateway's own reason for an MLX-only pick, and no button", async () => {
    const reason = "MLX-only — Maya serves GGUF via llama-server today, so this can't be installed yet";
    render(
      <Recommended
        {...props({
          fetchSuggestions: respond([
            model({
              name: "qwen2.5-coder-14b-mlx",
              displayName: "Qwen2.5-Coder 14B (MLX)",
              fitLevel: "good",
              format: "mlx",
              sources: { gguf: null, mlx: "hf:mlx-community/Qwen2.5-Coder-14B-4bit" },
              runnable: false,
              notRunnableReason: reason,
            }),
          ]),
        })}
      />,
    );
    await screen.findByText("Qwen2.5-Coder 14B (MLX)");

    // The server's wording wins over our generic client-side fallback.
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByText("no GGUF build — not runnable here")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download & serve" })).toBeNull();
  });

  // Live HF discovery surfaced runnable picks from accounts nobody has vetted,
  // each with a working one-click Download pointing at a stranger's binary. The
  // gateway now gates them by uploader.
  //
  // Careful about WHY: we are gating on *provenance*, not on our opinion of the
  // model. Three of us confidently called these repos "fabricated slop" because
  // we'd never heard of them — and we were flatly wrong (google/gemma-4-12B-it
  // is a real Google release with millions of downloads; it postdates our
  // training). A cutoff is a fact about the reader, not the world. The honest
  // claim is "we can't vouch for who built this", which stays true either way.
  //
  // A gate the user can't see is one they can't overrule, so the panel must say
  // how many vanished — and only reveal them on a deliberate click.
  describe("unverified uploaders", () => {
    const withHidden = (n: number) =>
      vi.fn().mockResolvedValue({
        system: SYSTEM,
        catalog: { source: "hf+seed", count: 25, untrustedHidden: n },
        useCase: "coding",
        results: RESULTS,
      } as SuggestResponse);

    it("says how many were withheld, instead of hiding them silently", async () => {
      render(<Recommended {...props({ fetchSuggestions: withHidden(11) })} />);
      expect(await screen.findByText(/11 models hidden — published by uploaders Maya doesn't vet/)).toBeTruthy();
    });

    it("says nothing when the gateway withheld nothing", async () => {
      render(<Recommended {...props({ fetchSuggestions: withHidden(0) })} />);
      await screen.findByText("Recommended for your Apple M4 Pro, 16GB");
      expect(screen.queryByText(/hidden/)).toBeNull();
    });

    it("asks the gateway for them only after a deliberate click, and warns while they show", async () => {
      const fetchSuggestions = withHidden(11);
      render(<Recommended {...props({ fetchSuggestions })} />);
      await screen.findByText(/11 models hidden/);

      // Closed by default: the first request must not opt out of the gate.
      expect(fetchSuggestions.mock.calls[0]![0]).not.toHaveProperty("trusted");

      fireEvent.click(screen.getByRole("button", { name: "Show them anyway" }));

      // Only now do we ask for the unvetted set — the gateway does the filtering;
      // we deliberately keep no copy of its allowlist to drift from.
      await waitFor(() => expect(fetchSuggestions.mock.calls[1]![0]).toMatchObject({ trusted: false }));
      expect(await screen.findByText(/Showing unverified uploaders/)).toBeTruthy();
    });
  });

  // The engine demotes unverified models but still SHOWS them, and the moment
  // their uploader is allowlisted they get a working Download button. A demoted
  // model that looks identical to a real one is still a trap, so the card says
  // so. Badge only on an explicit `false` — absent means the server doesn't send
  // the flag yet, and we badge nothing rather than guess.
  describe("unverified lineage badge", () => {
    it("badges a pick the engine could not vouch for", async () => {
      render(
        <Recommended
          {...props({
            fetchSuggestions: respond([
              model({ name: "qwopus3.5-9b-coder", displayName: "Qwopus3.5 9B", verified: false, score: 85.3 }),
            ]),
          })}
        />,
      );
      const title = await screen.findByText("Qwopus3.5 9B");
      expect(within(title.closest("article")!).getByText("unverified lineage")).toBeTruthy();
    });

    it("does not badge a verified model, nor one where the server omitted the flag", async () => {
      render(
        <Recommended
          {...props({
            fetchSuggestions: respond([
              model({ name: "qwen2.5-coder-7b", displayName: "Qwen2.5-Coder 7B", verified: true }),
              model({ name: "legacy-7b", displayName: "Legacy 7B" }), // flag absent
            ]),
          })}
        />,
      );
      await screen.findByText("Qwen2.5-Coder 7B");
      expect(screen.queryByText("unverified lineage")).toBeNull();
    });
  });

  it("names the publisher on the card — you should know whose binary you're about to run", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText("Qwen2.5-Coder 7B");
    // sources.gguf is `hf:Qwen/…` in the fixture.
    expect(screen.getAllByText("by Qwen").length).toBeGreaterThan(0);
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
