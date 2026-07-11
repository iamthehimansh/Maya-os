/** The panel, rendered against a real server response.
 *
 * `__fixtures__/suggest.live.json` is not hand-written: it is the verbatim body
 * of `GET /api/models/suggest?useCase=coding` from a real `maya serve` booted
 * off this tree, on himansh's Apple M2 Pro / 16 GB. Every other test in this
 * suite feeds the panel a fixture we invented — which is precisely how the view
 * came to read `system.cores` / `ramTotalGb` while the gateway was sending
 * `cpuCores` / `totalRamGb`: our fixtures agreed with us and the server didn't.
 *
 * This one can't drift quietly. If the wire shape changes, re-capture it and
 * the diff shows up here.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, Instance } from "./api";
import { Recommended } from "./Recommended";
import { publisherOf } from "./hwfit";
import type { SuggestResponse } from "./hwfit";
import live from "./__fixtures__/suggest.live.json";

const LIVE = live as unknown as SuggestResponse;

const props = () => ({
  models: [] as CatalogEntry[] | null,
  live: new Map<string, Instance>(),
  busy: null,
  onPull: vi.fn(),
  onLoad: vi.fn(),
  onUnload: vi.fn(),
  fetchSuggestions: vi.fn().mockResolvedValue(LIVE),
});

describe("Recommended — against a captured live gateway response", () => {
  // This suite renders the same panel three times; without cleanup the previous
  // DOM lingers and `screen` matches every copy.
  afterEach(cleanup);

  it("renders the real detected hardware in the heading and subtitle", async () => {
    render(<Recommended {...props()} />);

    const sys = LIVE.system;
    // Derived from the capture, not typed in: `availableRamGb` genuinely moves
    // between captures (5.0 → 4.8 GB as apps opened), and a hard-coded string
    // would make re-capturing the fixture look like a regression.
    // Before the field-name fix this read "Apple M2 Pro, NaNGB".
    expect(await screen.findByText(`Recommended for your ${sys.chip}, ${sys.totalRamGb}GB`)).toBeTruthy();
    // And this line threw `undefined.toFixed()`, white-screening the Models tab.
    expect(
      screen.getByText(
        `${sys.backend} · ${sys.cpuCores} cores · ${sys.availableRamGb.toFixed(1)} GB free · ${sys.memoryBandwidthGbs} GB/s`,
      ),
    ).toBeTruthy();
  });

  it("puts a real coding model on top with an honest fit badge", async () => {
    render(<Recommended {...props()} />);

    // The brief's acceptance case: a 16GB Apple Silicon Mac should be told to
    // run Qwen2.5-Coder, not a 70B it can never load.
    expect(await screen.findByText("Qwen2.5-Coder 7B")).toBeTruthy();
    expect(screen.getAllByText(/perfect fit|good fit/).length).toBeGreaterThan(0);

    const top = LIVE.results[0]!;
    expect(top.name).toBe("qwen2.5-coder-7b");
    expect(top.fitLevel).toBe("perfect");
    expect(top.runMode).toBe("gpu");
  });

  it("warns when a 'perfect' pick still exceeds the RAM that is free right now", async () => {
    const { findByText } = render(<Recommended {...props()} />);

    // Real numbers from the capture: the engine budgets against the machine's
    // 16 GB (→ "perfect"), but far less was actually free and the top pick needs
    // more than that. Without this warning the card promises a Serve that the
    // runtime guardrail would reject with "cannot fit".
    const top = LIVE.results[0]!;
    const free = LIVE.system.availableRamGb;
    expect(top.fitLevel).toBe("perfect");
    expect(top.requiredGb).toBeGreaterThan(free);

    // Scope to the top card: several picks in this capture exceed free RAM, so
    // they all carry the warning and a panel-wide lookup matches more than one.
    const card = (await findByText(top.displayName ?? top.name)).closest("article")!;
    expect(
      within(card).getByText(`needs ${top.requiredGb.toFixed(1)} GB — only ${free.toFixed(1)} GB free right now`),
    ).toBeTruthy();
  });

  // The capture now includes a real MLX-only pick from live HF discovery. Maya
  // cannot pull it (download.ts rejects a repo with no .gguf) and cannot serve
  // it (llamacpp.ts is the only backend), so it must be information, never an
  // offer — proven here against the gateway's actual bytes, not a hand fixture.
  it("renders a real MLX-only pick as information, never a Download button", async () => {
    const { findByText, getByText } = render(<Recommended {...props()} />);

    const mlx = LIVE.results.find((r) => r.format === "mlx")!;
    expect(mlx.runnable).toBe(false);
    expect(mlx.sources.gguf).toBeNull();

    const title = await findByText(mlx.displayName ?? mlx.name);
    // Scope to the MLX card: the GGUF picks in this capture are runnable and
    // *should* have Download buttons, so a panel-wide query proves nothing.
    const card = title.closest("article")!;
    expect(card.querySelector("button")).toBeNull();
    expect(getByText(mlx.notRunnableReason!)).toBeTruthy();

    // And the runnable GGUF picks still offer an action — no over-correction.
    // An already-pulled model offers Serve, not Download: in this capture
    // qwen2.5-coder-7b is installed, so only the un-installed one says Download.
    const toDownload = LIVE.results.filter((r) => r.runnable && !r.installed);
    const toServe = LIVE.results.filter((r) => r.runnable && r.installed);
    expect(toDownload.length).toBeGreaterThan(0);
    expect(toServe.length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Download & serve" }).length).toBe(toDownload.length);
    expect(screen.getAllByRole("button", { name: "Serve" }).length).toBe(toServe.length);
  });

  // The live gateway withheld runnable picks from accounts it can't vouch for.
  // Each would otherwise render a one-click Download for a stranger's binary —
  // a provenance concern, not a judgement on the models themselves.
  it("tells the user how many picks the gateway withheld, and who published the rest", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText(`Recommended for your ${LIVE.system.chip}, ${LIVE.system.totalRamGb}GB`);

    // Derived, not typed in: the count moves as the allowlist changes (it was 11
    // before MaziyarPanahi/mradermacher were admitted, 9 after).
    const hidden = LIVE.catalog!.untrustedHidden!;
    expect(hidden).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${hidden} models hidden`))).toBeTruthy();

    // Provenance is on every card — real owners from the live capture.
    for (const r of LIVE.results) {
      expect(screen.getAllByText(`by ${publisherOf(r)}`).length).toBeGreaterThan(0);
    }
  });

  // The two guards are orthogonal, and this pick proves it: it clears the
  // uploader gate (mlx-community is allowlisted) while still failing the lineage
  // check. The owner gate can't catch that; only the badge can.
  //
  // I originally wrote this test asserting the model was "fake". It is not —
  // `google/gemma-4-12B-it` is a genuine Google release from 2026-05-23 with
  // millions of downloads, and this community finetune of it has 720k of its
  // own. I'd simply never heard of any of them, which is a fact about my
  // training cutoff and not about the model. The assertion below is the one that
  // survives being wrong about that: we cannot trace this artifact's lineage,
  // so we decline to *vouch* for it — which is true whether it is excellent or
  // worthless.
  it("badges a pick it cannot vouch for, even when a trusted quantizer uploaded it", async () => {
    render(<Recommended {...props()} />);

    const unvouched = LIVE.results.find((r) => r.name.startsWith("gemma-4"))!;
    expect(publisherOf(unvouched)).toBe("mlx-community"); // ← clears the allowlist
    expect(unvouched.verified).toBe(false); // ← but lineage is untraceable

    const title = await screen.findByText(unvouched.displayName ?? unvouched.name);
    const card = title.closest("article")!;
    expect(within(card).getByText("unverified lineage")).toBeTruthy();
    expect(card.querySelector("button")).toBeNull(); // MLX → un-runnable, for now
  });

  // The badge only means something if it is RARE. An earlier lineage rule keyed
  // on "is the uploader the upstream org", which badged every third-party
  // quantizer — i.e. how nearly all good GGUF actually ships. Six picks wore the
  // badge and five of them were real models (Yi-Coder, DeepSeek-Coder,
  // Qwen3-Coder). A warning that cries wolf five times in six is wallpaper, and
  // it wouldn't be believed on the one that mattered.
  //
  // @hwfit rebuilt it on the HF `base_model` tag — real lineage rather than
  // ownership — and this capture proves it: Yi-Coder-9B, quantized by
  // MaziyarPanahi, traces to 01-ai and now carries NO badge, at full score.
  it("does not badge a third-party quantizer whose lineage checks out", async () => {
    render(<Recommended {...props()} />);

    const quantized = LIVE.results.find((r) => r.name === "yi-coder-9b-chat")!;
    expect(publisherOf(quantized)).toBe("MaziyarPanahi"); // not the upstream org…
    expect(quantized.verified).toBe(true); // …but the lineage is traceable

    const title = await screen.findByText(quantized.displayName ?? quantized.name);
    const card = within(title.closest("article")!);
    expect(card.queryByText("unverified lineage")).toBeNull();
    expect(card.getByRole("button", { name: "Download & serve" })).toBeTruthy();
  });

  // Exactly one pick in the whole default view is unvouched. That is what makes
  // the badge worth reading.
  it("badges exactly the picks it cannot vouch for — and no others", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText(`Recommended for your ${LIVE.system.chip}, ${LIVE.system.totalRamGb}GB`);

    const unvouched = LIVE.results.filter((r) => r.verified === false);
    expect(unvouched.length).toBe(1);
    expect(screen.getAllByText("unverified lineage").length).toBe(unvouched.length);
  });

  it("does not badge the verified top pick", async () => {
    render(<Recommended {...props()} />);
    const top = LIVE.results[0]!;
    expect(top.verified).toBe(true);

    const title = await screen.findByText(top.displayName ?? top.name);
    expect(within(title.closest("article")!).queryByText("unverified lineage")).toBeNull();
  });

  it("reports the catalog came from live HuggingFace discovery, not just the seed", async () => {
    render(<Recommended {...props()} />);
    await screen.findByText("Recommended for your Apple M2 Pro, 16GB");

    expect(LIVE.catalog?.source).toBe("hf+seed");
    expect(LIVE.catalog?.stale).toBe(false);
    // The "offline catalog" warning is only for a seed-only fallback.
    expect(screen.queryByText(/offline catalog/)).toBeNull();
  });
});
