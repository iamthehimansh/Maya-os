// GET /api/models/suggest — against the REAL @maya-ai/hwfit engine.
//
// Why this file exists, when test/suggest.mjs already covers the route:
// suggest.mjs injects a *fake* engine, and Recommended.test.tsx stubs the
// *fetch*. Both were green while the feature was dead in production — because
// nothing ever checked that the real engine satisfies `HwfitEngine`, and that
// the composition root actually hands it to the gateway. It didn't:
// `maya serve` built a gateway with no `hwfit`, so /api/models/suggest 501'd
// for every real user. A fake on both sides of a seam tests the seam and not
// the wire.
//
// So this suite deliberately uses NO fake engine:
//   1. the real engine is injected into the real route → must not 501/500
//   2. the real detector reports a sane machine
//   3. the real seed catalog + real scoring, on a PINNED 16GB Apple Silicon,
//      produces the recommendations the brief asks for
//   4. the shipped composition root (apps/cli) really does inject the engine
//
// Hermetic: loadCatalog runs with `offline: true`, so the curated seed is
// exercised end-to-end without a HuggingFace round-trip.  node test/suggest-live.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../dist/server.js";
import { enrich, isTrustedRepo, parseSuggestQuery } from "../dist/suggest.js";
import { budgetGb, detectHardware, loadCatalog, loadCatalogSnapshot, rankModels, SEED_CATALOG } from "@maya-ai/hwfit";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

// The engine exactly as `maya serve` injects it, but pinned offline so the
// suite never depends on HuggingFace being reachable. Offline is also the
// interesting case: it is the one where the route must admit it is serving the
// curated seed rather than claiming live HuggingFace results.
const engine = {
  detectHardware,
  loadCatalog: (opts = {}) => loadCatalog({ ...opts, offline: true }),
  loadCatalogSnapshot: (opts = {}) => loadCatalogSnapshot({ ...opts, offline: true }),
  rankModels,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maya-suggest-live-"));
const fakeManager = { on() {}, instances: () => [], instanceFor: () => undefined };
const app = createGateway({ manager: fakeManager, modelsDir: tmp, port: 0, hwfit: engine }).app;
const get = (qs = "") =>
  app.fetch(new Request(`http://127.0.0.1/api/models/suggest${qs}`, { headers: { host: "127.0.0.1:4100" } }));

// ── 1. the real engine satisfies the route's contract ───────────────────────
// This is the assertion that would have caught the shipped bug. A 501 means
// nothing was injected; a 500 means the engine doesn't implement HwfitEngine
// (e.g. the `loadCatalog` the gateway calls at suggest.ts:247 doesn't exist).

let res = await get("?useCase=coding");
assert.notEqual(res.status, 501, "real engine injected, yet route reports 'hwfit not wired' — the composition root is broken");
assert.notEqual(res.status, 500, "real engine does not satisfy HwfitEngine — a method the gateway calls is missing");
assert.equal(res.status, 200, `expected 200 from the live recommender, got ${res.status}`);

let body = await res.json();
assert.equal(body.useCase, "coding");
assert(Array.isArray(body.results) && body.results.length > 0, "the live engine returned no recommendations at all");
assert(body.catalog.count > 0, "catalog is empty — the curated seed did not load");
assert.equal(body.catalog.source, "seed", "offline load must report the curated seed, not 'hf+seed'");

// The wire fields the dashboard renders must survive the real engine, not just
// the fake — `installed`/`format`/`runnable` are added by the gateway.
const top = body.results[0];
for (const k of ["name", "id", "displayName", "provider", "paramsB", "fitLevel", "runMode", "quant", "context", "requiredGb", "speedTps", "score", "subscores", "sources", "installed", "format", "runnable"]) {
  assert(k in top, `live recommendation is missing the '${k}' field the dashboard reads`);
}
assert(top.id.startsWith("local/"), "id must be the pull-ready `local/<name>` the models list uses");

// ── 2. the real hardware detector ───────────────────────────────────────────

const sys = body.system;
// The wire reports the host truthfully rather than squeezing it into a narrow
// union — assert it against the actual process, not a hand-written allowlist.
assert.equal(sys.platform, process.platform, "the reported platform is not this host's platform");
assert(typeof sys.chip === "string" && sys.chip.length > 0, "no chip name detected");
assert(sys.totalRamGb > 0, "detector reported 0 total RAM");
assert(sys.availableRamGb > 0 && sys.availableRamGb <= sys.totalRamGb, "available RAM must be >0 and ≤ total");
assert(["metal", "cuda", "cpu"].includes(sys.backend), `unknown backend: ${sys.backend}`);
assert(sys.memoryBandwidthGbs > 0, "bandwidth must be positive — tok/s is derived from it");
if (sys.isAppleSilicon) assert.equal(sys.backend, "metal", "Apple Silicon must run on the metal backend");

// ── 3. the brief's acceptance case, pinned so it can't flake ────────────────
// "On himansh's 16GB Apple Silicon Mac it should recommend sensible local
// coding models (e.g. Qwen2.5-Coder 7B/14B at Q4) as perfect/good and flag
// too-big ones."  Pinned rather than read from the host: the real machine's
// free RAM moves as apps open, and a DoD assertion must not depend on whether
// Chrome is running. Real catalog, real scoring — only the machine is fixed.

const M4_16GB = {
  platform: "darwin",
  chip: "Apple M4 Pro",
  isAppleSilicon: true,
  cpuCores: 12,
  gpuCores: 16,
  totalRamGb: 16,
  availableRamGb: 11,
  memoryBandwidthGbs: 273,
  backend: "metal",
};

const ranked = rankModels(M4_16GB, SEED_CATALOG, { useCase: "coding", limit: 50 });
assert(ranked.length > 0, "the seed catalog produced no ranking on a 16GB Mac");

// Sorted by score, descending — the panel renders this order.
for (let i = 1; i < ranked.length; i++) {
  assert(ranked[i - 1].score >= ranked[i].score, "results are not sorted by score descending");
}

const byName = (needle) => ranked.filter((r) => `${r.name} ${r.displayName}`.toLowerCase().includes(needle));
const coders = byName("qwen2.5-coder");
assert(coders.length > 0, "Qwen2.5-Coder is not in the seed catalog — the brief's acceptance model is missing");

const runnable7or14 = coders.filter((r) => (r.paramsB >= 6 && r.paramsB <= 9) || (r.paramsB >= 13 && r.paramsB <= 15));
assert(runnable7or14.length > 0, "neither Qwen2.5-Coder 7B nor 14B appears in the ranking");
const good = runnable7or14.filter((r) => ["perfect", "good"].includes(r.fitLevel));
assert(
  good.length > 0,
  `16GB Mac should rate a Qwen2.5-Coder 7B/14B as perfect|good, got: ${runnable7or14.map((r) => `${r.name}=${r.fitLevel}`).join(", ")}`,
);
// A coding model — not a general chat model — should top the list for `coding`.
assert(
  /coder|code/i.test(`${ranked[0].name} ${ranked[0].arch}`),
  `use-case=coding put a non-coding model on top: ${ranked[0].name}`,
);

// Deliberately NOT asserting Q4 here. With the quant left free the planner
// climbs the ladder to the best quant that still fits — on 11GB free that's
// Q5_K_M for the 7B, which is *higher* quality than the brief's Q4 example and
// still `perfect`. Pinning the expectation to Q4 would fail the engine for
// doing something better. What must hold is that the pick is real and usable:
// Fit is planned against the memory BUDGET (total × 0.8 on Apple Silicon), not
// against free-right-now RAM — deliberately, so the "what should I download?"
// list doesn't reshuffle every time the user opens a browser tab. Asserting
// against availableRamGb here would be testing an invariant the engine never
// promised. (`availableRamGb` is still on SystemInfo so the UI can warn about
// instantaneous pressure — see the note I sent @ui.)
const LADDER = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];
const budget16 = budgetGb(M4_16GB);
for (const r of good) {
  assert(LADDER.includes(r.quant), `${r.name} was assigned an off-ladder quant: ${r.quant}`);
  assert(r.speedTps > 0, `${r.name} has a non-positive tok/s estimate`);
  assert(r.requiredGb <= budget16, `${r.name} is rated ${r.fitLevel} but exceeds the ${budget16}GB budget`);
  assert(r.context >= 1024, `${r.name} context collapsed below the 1024 floor`);
}

// The brief's literal acceptance case is the *pinned* one: ask for Q4 and the
// 7B/14B must come back runnable, which is what the UI's quant selector does.
const atQ4 = rankModels(M4_16GB, SEED_CATALOG, { useCase: "coding", limit: 50, quant: "Q4_K_M" });
const q4_7b = atQ4.find((r) => r.name.includes("qwen2.5-coder-7b"));
const q4_14b = atQ4.find((r) => r.name.includes("qwen2.5-coder-14b"));
assert(q4_7b && q4_14b, "Qwen2.5-Coder 7B and 14B must both rank when Q4_K_M is pinned");
assert.equal(q4_7b.quant, "Q4_K_M", "a pinned quant must be honoured, not overridden by the planner");
assert(
  ["perfect", "good"].includes(q4_7b.fitLevel),
  `Qwen2.5-Coder 7B @ Q4_K_M must be perfect|good on a 16GB Mac, got ${q4_7b.fitLevel} (${q4_7b.requiredGb}GB)`,
);
assert(
  ["perfect", "good"].includes(q4_14b.fitLevel),
  `Qwen2.5-Coder 14B @ Q4_K_M must be perfect|good on a 16GB Mac, got ${q4_14b.fitLevel} (${q4_14b.requiredGb}GB)`,
);

// …and the too-big ones must be flagged, not silently recommended.
const huge = ranked.filter((r) => r.paramsB >= 65);
if (huge.length > 0) {
  for (const r of huge) {
    assert(
      ["marginal", "too_tight", "no_fit"].includes(r.fitLevel),
      `a ${r.paramsB}B model is rated '${r.fitLevel}' on a 16GB machine — the fit planner is too optimistic`,
    );
  }
  // A 70B must never outrank a model that actually fits.
  assert(ranked[0].paramsB < 65, "a >=65B model topped the ranking on a 16GB Mac");
}

// A tiny machine must not be handed a model it cannot load, and must be told
// to run something smaller than the 16GB machine gets.
const TINY = { ...M4_16GB, chip: "Apple M1", totalRamGb: 8, availableRamGb: 3.2, gpuCores: 7, memoryBandwidthGbs: 68 };
const budgetTiny = budgetGb(TINY);
const onTiny = rankModels(TINY, SEED_CATALOG, { useCase: "coding", limit: 50, fitOnly: true });
assert(onTiny.length > 0, "an 8GB Mac must still get at least one runnable coding model");
for (const r of onTiny) {
  assert.notEqual(r.fitLevel, "no_fit", "fitOnly returned a model that cannot fit");
  assert(r.requiredGb <= budgetTiny, `${r.name} needs ${r.requiredGb}GB, over the ${budgetTiny}GB budget of an 8GB Mac`);
}
// The 14B that was `good` on 16GB must not still be `good` on 8GB — the fit
// level has to actually track the machine.
const tiny14b = rankModels(TINY, SEED_CATALOG, { useCase: "coding", limit: 50 }).find((r) => r.name.includes("qwen2.5-coder-14b"));
if (tiny14b) {
  assert(
    !["perfect", "good"].includes(tiny14b.fitLevel),
    `Qwen2.5-Coder 14B is rated '${tiny14b.fitLevel}' on an 8GB Mac — the fit level is not tracking the hardware`,
  );
}

// ── 3b. no unvetted repo gets a Download button by default ──────────────────
// Live HF discovery queries by keyword, so third-party finetunes and re-uploads
// land in the catalog alongside upstream releases. `Download & serve` fetches
// that account's binary and runs it on the user's machine, so the DEFAULT view
// only offers publishers we can vouch for; everything else is one `trusted=0`
// away and reported via `untrustedHidden`.
//
// This is a claim about PROVENANCE, not quality — several withheld repos are
// real and popular (a Gemma-4 coder merge with 720k downloads). We are not
// saying they're bad; we're saying we can't vouch for who built them, and that
// is the relevant question at the moment you run a binary.

let trustedRes = await get("?useCase=coding&limit=100");
let trustedBody = await trustedRes.json();
for (const r of trustedBody.results) {
  assert(
    isTrustedRepo(r.sources.hfRepo),
    `an untrusted repo reached the dashboard with runnable=${r.runnable}: ${r.sources.hfRepo}`,
  );
}
assert(typeof trustedBody.catalog.untrustedHidden === "number", "the route must report what it withheld, not hide it silently");

// …and the escape hatch really opens it (otherwise the filter is untestable
// and the user has no way to reach a legitimate community model).
const openRes = await get("?useCase=coding&limit=100&trusted=0");
const openBody = await openRes.json();
assert(
  openBody.results.length >= trustedBody.results.length,
  "trusted=0 must return at least as many picks as the filtered default",
);
// Nothing may be withheld when the filter is off.
assert.equal(openBody.catalog.untrustedHidden, 0, "trusted=0 must withhold nothing");

// The default must not be defeatable by a typo — anything that isn't an
// explicit 0/false stays safe.
for (const v of ["", "yes", "1", "true", "banana"]) {
  assert.equal(parseSuggestQuery({ trusted: v }).trusted, true, `trusted="${v}" must fail closed`);
}
for (const v of ["0", "false", "FALSE"]) {
  assert.equal(parseSuggestQuery({ trusted: v }).trusted, false, `trusted="${v}" must open the catalog`);
}
assert.equal(parseSuggestQuery({}).trusted, true, "trusted defaults ON");

// The curated seed must survive its own filter — a guard that drops the models
// we ship is a broken guard, not a safe one.
for (const m of SEED_CATALOG) {
  assert(isTrustedRepo(m.hfRepo), `the curated seed contains an untrusted owner: ${m.hfRepo}`);
}

// Every pick carries its publisher + a trust verdict, so the dashboard can badge
// an unvetted card without keeping its own (driftable) copy of TRUSTED_OWNERS.
for (const r of trustedBody.results) {
  assert(typeof r.publisher === "string" && r.publisher.length > 0, `${r.name} has no publisher`);
  assert.equal(r.trusted, true, "a pick in the DEFAULT view must be trusted by construction");
  assert.equal(r.publisher, r.sources.hfRepo.split("/")[0], "publisher must be the repo's actual owner");
}
// …and with the gate off, the unvetted ones are individually marked rather than
// silently mixed in with the real models.
const untrusted = openBody.results.filter((r) => !r.trusted);
assert.equal(untrusted.length, trustedBody.catalog.untrustedHidden, "`trusted` per pick must agree with `untrustedHidden`");
for (const r of untrusted) assert.equal(isTrustedRepo(r.sources.hfRepo), false, `${r.name} marked untrusted but its owner is allowlisted`);

// A real model from a reputable quantiser must NOT be collateral damage. Yi-Coder
// is a genuine 01-ai model; excluding MaziyarPanahi was costing us it.
assert(isTrustedRepo("MaziyarPanahi/Yi-Coder-9B-Chat-GGUF"), "MaziyarPanahi is a reputable quantiser — Yi-Coder is a real model");

// `verified` must reach the wire on EVERY pick — the UI badges on an explicit
// `false`, so a missing field silently disarms the badge rather than failing loud.
for (const r of [...trustedBody.results, ...openBody.results]) {
  assert.equal(typeof r.verified, "boolean", `${r.name}: 'verified' is absent from the wire — the UNVERIFIED badge cannot render`);
}
// A seed model is both, and must never be badged.
const seedPick = trustedBody.results.find((r) => r.name === "qwen2.5-coder-7b");
assert(seedPick?.verified === true && seedPick?.trusted === true, "a curated seed model must be trusted AND verified");

// ── trusted ≠ verified: the case that survives BOTH guards ──────────────────
// This suite loads the catalog OFFLINE (deliberately — no HuggingFace in CI),
// so the seed is all it sees and every pick is trusted AND verified. The live
// assertions above therefore cannot exercise the interesting combination at
// all. Pin it deterministically through the pure `enrich()` instead — otherwise
// this is a no-op that merely *looks* like coverage.
//
// The real, observed case (live HF, captured on this machine):
//   mlx-community/gemma-4-12b-coder-fable5-composer2.5-8bit
// `mlx-community` is an allowlisted uploader, so the owner gate admits it — but
// the model itself is a third-party finetune of Google's Gemma 4, and nobody
// here can vouch for who built it or what went into it.
//
// IMPORTANT, because an earlier version of this file got it wrong: this model
// is NOT fake. `google/gemma-4-12B-it` is a genuine Google release and the
// community coder merge of it has ~720k downloads. The point is not that it's
// fiction — it's that "trusted uploader" and "known lineage" are DIFFERENT
// facts, and a card that shows only the first is lying by omission.
const unvetted = enrich(
  {
    ...seedPick,
    name: "gemma-4-12b-coder-fable5-composer2.5",
    id: "local/gemma-4-12b-coder-fable5-composer2.5",
    verified: false,
    sources: { gguf: null, mlx: "hf:mlx-community/gemma-4-…-8bit", hfRepo: "mlx-community/gemma-4-12b-coder-fable5-composer2.5-8bit" },
  },
  new Set(),
);
assert.equal(unvetted.trusted, true, "the uploader IS allowlisted — which is exactly why the owner gate cannot answer this question");
assert.equal(unvetted.verified, false, "an unvouched-for finetune must not claim verified lineage");
assert.equal(unvetted.publisher, "mlx-community");
assert.equal(unvetted.runnable, false, "MLX — not installable today regardless");

// The same model re-uploaded as GGUF by that same trusted account WOULD be
// runnable, and then the badge is the only thing standing between the user and
// a one-click install of a binary whose provenance nobody has checked. So
// `verified:false` must survive `enrich()`: if it were dropped, the card would
// render as an ordinary, fully-vouched-for model.
const unvettedGguf = enrich(
  { ...unvetted, sources: { gguf: "hf:mlx-community/x/y.gguf", mlx: null, hfRepo: "mlx-community/gemma-4-12b-coder-GGUF" } },
  new Set(),
);
assert.equal(unvettedGguf.runnable, true, "fixture sanity: a gguf source is runnable");
assert.equal(unvettedGguf.trusted, true, "fixture sanity: allowlisted uploader");
assert.equal(
  unvettedGguf.verified,
  false,
  "a RUNNABLE pick from a trusted uploader lost its `verified:false` — the UNVERIFIED badge would not render, and the user would one-click-install a binary whose lineage nobody has checked",
);

// ── 4. the composition root really wires the engine ─────────────────────────
// The bug was not in the engine or the route — both were green. It was that
// `maya serve` never passed `hwfit` to startGateway. Nothing above can catch
// that (this file builds its own gateway), so assert on the shipped source:
// the one place a user's gateway is actually constructed.

const cliSrc = fs.readFileSync(path.join(repoRoot, "apps/cli/src/index.ts"), "utf8");
const startCall = cliSrc.slice(cliSrc.indexOf("startGateway({"));
assert(startCall.length > 0, "apps/cli no longer calls startGateway — this guard needs updating");
const callBody = startCall.slice(0, startCall.indexOf("});") + 3);
assert(
  /\bhwfit\s*:/.test(callBody),
  "REGRESSION: `maya serve` builds its gateway without `hwfit` — /api/models/suggest will 501 for every real user, even though every unit test passes",
);
assert(
  /from ["']@maya-ai\/hwfit["']/.test(cliSrc),
  "apps/cli does not import @maya-ai/hwfit — the recommender cannot be wired",
);

// ── 5. and the guard itself still works ─────────────────────────────────────
// Without an engine the route must 501 (not crash, not return a fake ranking).

const bare = createGateway({ manager: fakeManager, modelsDir: tmp, port: 0 }).app;
const bareRes = await bare.fetch(
  new Request("http://127.0.0.1/api/models/suggest", { headers: { host: "127.0.0.1:4100" } }),
);
assert.equal(bareRes.status, 501, "a gateway with no engine must 501, so the omission is loud rather than silent");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`SUGGEST LIVE-ENGINE PASS ✅  (${sys.chip}, ${sys.totalRamGb}GB, ${sys.backend} · seed=${SEED_CATALOG.length} · top=${ranked[0].name} ${ranked[0].quant} ${ranked[0].fitLevel})`);
