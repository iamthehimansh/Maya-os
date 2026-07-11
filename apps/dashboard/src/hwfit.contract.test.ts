/** The wire contract, enforced by the compiler.
 *
 * Every runtime test in this suite feeds the panel a fixture *we* wrote, so the
 * dashboard and its fixtures can agree perfectly and still both disagree with
 * the server — which is exactly what happened: the view read `system.cores` /
 * `ramTotalGb` / `ramAvailableGb` / `bandwidthGbs`, while the gateway puts the
 * engine's `SystemInfo` on the wire verbatim as `cpuCores` / `totalRamGb` /
 * `availableRamGb` / `memoryBandwidthGbs`. Green tests, `NaN`GB heading, and a
 * TypeError the moment a real response arrived.
 *
 * So the fixtures don't get a vote here. These are type-level assertions
 * against the gateway's *exported* wire types: if either side renames a field,
 * `tsc --noEmit` (which `pnpm build` runs) fails with a real type error rather
 * than the dashboard discovering it in the browser.
 */
import { describe, expect, it } from "vitest";
import type { SuggestResponse as WireResponse, Suggestion as WireSuggestion, SystemInfo as WireSystem } from "@maya-ai/gateway";
import type { SuggestResponse, Suggestion, SystemInfo } from "./hwfit";

/** Compiles only if every field the server sends is one the view can read. */
type AssignableTo<Wire, View> = Wire extends View ? true : never;

const _system: AssignableTo<WireSystem, SystemInfo> = true;
const _suggestion: AssignableTo<WireSuggestion, Suggestion> = true;
const _response: AssignableTo<WireResponse, SuggestResponse> = true;

describe("wire contract: gateway → dashboard", () => {
  it("the gateway's SystemInfo/Suggestion/SuggestResponse satisfy the view's types", () => {
    // The real assertions are the three declarations above — they are checked by
    // tsc, not by vitest. This case keeps them from being flagged as unused and
    // documents why the file exists.
    expect([_system, _suggestion, _response]).toEqual([true, true, true]);
  });

  it("reads the field names the engine actually emits", () => {
    // A literal typed as the *wire* type: renaming any of these in hwfit.ts's
    // SystemInfo stops compiling. Values mirror himansh's 16GB Apple Silicon Mac.
    const sys: WireSystem = {
      platform: "darwin",
      chip: "Apple M4 Pro",
      isAppleSilicon: true,
      cpuCores: 12,
      gpuCores: 16,
      totalRamGb: 16,
      availableRamGb: 9.2,
      memoryBandwidthGbs: 273,
      backend: "metal",
    };
    const view: SystemInfo = sys;
    expect(view.cpuCores).toBe(12);
    expect(view.totalRamGb).toBe(16);
    expect(view.availableRamGb).toBe(9.2);
    expect(view.memoryBandwidthGbs).toBe(273);
  });
});
