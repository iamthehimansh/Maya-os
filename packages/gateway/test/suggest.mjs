// GET /api/models/suggest — the hardware-aware recommender's wire surface.
// Drives the REAL Hono app with a fake hwfit engine: no HuggingFace, no sysctl,
// no llama-server. What's under test is the gateway's half of the contract —
// query validation, the `installed`/`format` enrichment the dashboard depends
// on, caching, and how the route degrades when discovery fails.  node test/suggest.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../dist/server.js";
import { parseSuggestQuery, enrich } from "../dist/suggest.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SYSTEM = {
  platform: "darwin",
  chip: "Apple M4 Pro",
  isAppleSilicon: true,
  cpuCores: 12,
  gpuCores: 16,
  totalRamGb: 16,
  availableRamGb: 9.4,
  memoryBandwidthGbs: 273,
  backend: "metal",
};

/** Two picks: one installed on disk + gguf-resolvable, one that fits nothing. */
const rec = (over = {}) => ({
  name: "qwen2.5-coder-7b",
  id: "local/qwen2.5-coder-7b",
  displayName: "Qwen2.5-Coder 7B Instruct",
  provider: "Qwen",
  paramsB: 7.6,
  isMoe: false,
  arch: "qwen2",
  fitLevel: "perfect",
  runMode: "gpu",
  quant: "Q4_K_M",
  context: 32768,
  requiredGb: 5.8,
  speedTps: 42.1,
  score: 87.4,
  subscores: { quality: 82, speed: 71, fit: 100, context: 100 },
  sources: { gguf: "hf:Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/qwen2.5-coder-7b-instruct-q4_k_m.gguf", mlx: null, hfRepo: "Qwen/Qwen2.5-Coder-7B-Instruct" },
  reasons: ["fits unified memory with 3.1GB headroom"],
  ...over,
});

function fakeEngine(over = {}) {
  const calls = { detect: 0, catalog: 0, rank: [] };
  return {
    calls,
    detectHardware: async () => {
      calls.detect++;
      return SYSTEM;
    },
    loadCatalog: async (o) => {
      calls.catalog++;
      if (over.catalogFails) throw new Error("HF unreachable");
      return over.catalog ?? [{ n: 1 }, { n: 2 }, { n: 3 }];
    },
    rankModels: (system, catalog, opts) => {
      calls.rank.push({ system, catalog, opts });
      return over.results ?? [rec()];
    },
  };
}

/** modelsDir with ONE model installed: local/qwen2.5-coder-7b. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maya-suggest-"));
fs.mkdirSync(path.join(tmp, "qwen2.5-coder-7b"));
fs.writeFileSync(path.join(tmp, "qwen2.5-coder-7b", "qwen2.5-coder-7b-Q4_K_M.gguf"), "x");

const fakeManager = { on() {}, instances: () => [], instanceFor: () => undefined };
const gw = (hwfit) => createGateway({ manager: fakeManager, modelsDir: tmp, port: 0, ...(hwfit ? { hwfit } : {}) }).app;
// The admin plane is local-only; an undici Request sets no Host header, so we
// supply it — exactly what a real dashboard call carries.
const get = (app, qs = "", headers = { host: "127.0.0.1:4100" }) =>
  app.fetch(new Request(`http://127.0.0.1/api/models/suggest${qs}`, { headers }));

// ── query validation ────────────────────────────────────────────────────────
// A typo'd enum must 400, not silently rank for the wrong use-case.

let q = parseSuggestQuery({});
assert.equal(q.useCase, "coding", "coding is the default use-case");
assert.equal(q.limit, 20);
assert.equal(q.sortBy, "score");
assert.equal(q.fitOnly, false);
assert.equal(q.refresh, false);

assert(parseSuggestQuery({ useCase: "codeing" }).error?.includes("unknown useCase"), "typo'd useCase rejected, not defaulted");
assert(parseSuggestQuery({ sortBy: "price" }).error?.includes("unknown sortBy"), "unknown sortBy rejected");
assert(parseSuggestQuery({ quant: "Q4" }).error?.includes("unknown quant"), "free-form quant rejected (must be core's Quant union)");
assert.equal(parseSuggestQuery({ quant: "Q4_K_M" }).quant, "Q4_K_M", "valid quant passes through");

// Limits clamp instead of 400ing — a bad page size can't produce a wrong ranking.
assert.equal(parseSuggestQuery({ limit: "9999" }).limit, 100, "limit clamped to LIMIT_MAX");
assert.equal(parseSuggestQuery({ limit: "0" }).limit, 20, "limit < 1 → default");
assert.equal(parseSuggestQuery({ limit: "abc" }).limit, 20, "garbage limit → default");
assert.equal(parseSuggestQuery({ limit: "7" }).limit, 7);

assert.equal(parseSuggestQuery({ fitOnly: "true" }).fitOnly, true);
assert.equal(parseSuggestQuery({ fitOnly: "1" }).fitOnly, true);
assert.equal(parseSuggestQuery({ fitOnly: "false" }).fitOnly, false);
assert.equal(parseSuggestQuery({ search: "  qwen " }).search, "qwen", "search trimmed");
assert.equal(parseSuggestQuery({ search: "   " }).search, undefined, "blank search dropped, not sent as ''");
assert.equal(parseSuggestQuery({ targetContext: "128" }).targetContext, undefined, "sub-512 targetContext ignored");
assert.equal(parseSuggestQuery({ targetContext: "32768" }).targetContext, 32768);
console.log("SUGGEST QUERY VALIDATION PASS ✅");

// ── enrichment: the two fields only the gateway can supply ──────────────────
const installed = new Set(["local/qwen2.5-coder-7b"]);
assert.equal(enrich(rec(), installed).installed, true, "installed model flagged → UI shows Load, not Download");
assert.equal(enrich(rec({ id: "local/nope" }), installed).installed, false);
assert.equal(enrich(rec(), installed).format, "gguf", "gguf source → gguf format");
assert.equal(enrich(rec({ sources: { gguf: null, mlx: "hf:mlx-community/x/y.safetensors", hfRepo: "r" } }), installed).format, "mlx", "mlx-only → mlx");
// The whole point of @ui's contract note: an unresolvable file is info-only, NOT a broken button.
assert.equal(enrich(rec({ sources: { gguf: null, mlx: null, hfRepo: "r" } }), installed).format, null, "no resolvable file → format null (card renders info-only)");
console.log("SUGGEST ENRICHMENT PASS ✅");

// ── the admin guard covers this route ───────────────────────────────────────
// /api/models/suggest sits on the admin plane: it must never answer through a
// tunnel/proxy. (It reads hardware and can trigger a pull-worthy list; the same
// rule that protects /api/fs/read protects it.)
let res = await get(gw(fakeEngine()), "", { host: "abc.trycloudflare.com" });
assert.equal(res.status, 403, "tunneled Host → 403, suggest is not exposed publicly");
res = await get(gw(fakeEngine()), "", { host: "127.0.0.1:4100", "x-forwarded-for": "1.2.3.4" });
assert.equal(res.status, 403, "proxy headers → 403 even with a localhost Host");
console.log("SUGGEST ADMIN-GUARD PASS ✅");

// ── 501 when the engine isn't wired ─────────────────────────────────────────
res = await get(gw(null));
assert.equal(res.status, 501, "no engine → 501, never a fake ranking");
assert((await res.json()).error.message.includes("hwfit"), "501 names the missing engine");

// ── happy path: full envelope ───────────────────────────────────────────────
let eng = fakeEngine();
let app = gw(eng);
res = await get(app);
assert.equal(res.status, 200);
let body = await res.json();
assert.equal(body.system.chip, "Apple M4 Pro", "system carries the chip the UI renders");
assert.equal(body.system.totalRamGb, 16);
assert.equal(body.useCase, "coding");
assert.equal(body.catalog.count, 3, "catalog size reported");
assert.equal(body.catalog.source, "hf+seed", "live discovery → hf+seed");
assert.equal(body.catalog.stale, false);
assert.equal(body.results.length, 1);
const r0 = body.results[0];
// Every field @ui said the card hard-needs, on the wire, camelCase (contract v1.1).
for (const f of ["name", "provider", "paramsB", "isMoe", "fitLevel", "runMode", "quant", "context", "requiredGb", "speedTps", "score", "subscores", "sources", "installed", "format", "reasons"]) {
  assert(f in r0, `wire field missing: ${f}`);
}
assert.equal(r0.installed, true, "the model that IS in modelsDir comes back installed:true");
assert.equal(r0.format, "gguf");
// Download→serve must be a two-call flow with no string surgery in the UI.
assert.equal(r0.sources.gguf, "hf:Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/qwen2.5-coder-7b-instruct-q4_k_m.gguf", "pull string carries the RESOLVED .gguf filename");
assert.equal(r0.id, `local/${r0.name}`, "id is local/<name> — pull(source,name) then load(name)");
console.log("SUGGEST ENVELOPE PASS ✅");

// A model NOT on disk must not be flagged installed (the inverse of the above).
eng = fakeEngine({ results: [rec({ name: "deepseek-coder-33b", id: "local/deepseek-coder-33b" })] });
body = await (await get(gw(eng))).json();
assert.equal(body.results[0].installed, false, "uninstalled model → installed:false → UI shows Download & serve");

// ── query reaches the engine ────────────────────────────────────────────────
eng = fakeEngine();
app = gw(eng);
await get(app, "?useCase=reasoning&fitOnly=true&limit=5&search=qwen&sortBy=speed&quant=Q6_K");
const opts = eng.calls.rank.at(-1).opts;
assert.equal(opts.useCase, "reasoning");
assert.equal(opts.fitOnly, true);
assert.equal(opts.limit, 5);
assert.equal(opts.search, "qwen");
assert.equal(opts.sortBy, "speed");
assert.equal(opts.quant, "Q6_K");
assert.equal(eng.calls.rank.at(-1).system.chip, "Apple M4 Pro", "detected hardware is passed to the engine, not guessed");

res = await get(app, "?useCase=nope");
assert.equal(res.status, 400, "bad enum → 400");
assert((await res.json()).error.message.includes("known:"), "400 lists the valid values");
console.log("SUGGEST QUERY PLUMBING PASS ✅");

// ── caching ─────────────────────────────────────────────────────────────────
// Hardware has a 5s TTL and the catalog 30min — a dashboard poll must not
// spawn sysctl or hit HuggingFace on every keystroke.
eng = fakeEngine();
app = gw(eng);
await get(app);
await get(app);
await get(app);
assert.equal(eng.calls.detect, 1, "hardware detected once inside the TTL, not per request");
assert.equal(eng.calls.catalog, 1, "catalog loaded once inside the TTL, not per request");
await get(app, "?refresh=true");
assert.equal(eng.calls.catalog, 2, "refresh=true busts the catalog cache");
console.log("SUGGEST CACHE PASS ✅");

// ── degradation: HF discovery fails ─────────────────────────────────────────
// The cache is per-gateway (createGateway owns it), so these two cases are
// genuinely independent — no cross-contamination through a module singleton.

// Cold: discovery fails and nothing was ever cached → 503 naming the reason.
// We must NOT invent a ranking out of an empty catalog.
let attempt = 0;
const flaky = {
  detectHardware: async () => SYSTEM,
  loadCatalog: async () => {
    attempt++;
    if (attempt === 1) throw new Error("HF unreachable");
    return [{ n: 1 }];
  },
  rankModels: () => [rec()],
};
res = await get(gw(flaky));
assert.equal(res.status, 503, "cold catalog + failed discovery → 503, not an empty//fake list");
assert((await res.json()).error.message.includes("HF unreachable"), "503 carries the real cause");

// Warm: a later refresh fails, but we already hold a catalog → still 200, and
// honestly labelled. Offline must degrade, not error the dashboard out.
let warmAttempt = 0;
const warmThenFail = {
  detectHardware: async () => SYSTEM,
  loadCatalog: async () => {
    warmAttempt++;
    if (warmAttempt === 1) return [{ n: 1 }, { n: 2 }];
    throw new Error("HF unreachable");
  },
  rankModels: () => [rec()],
};
app = gw(warmThenFail);
body = await (await get(app)).json();
assert.equal(body.catalog.source, "hf+seed", "first load is live");
assert.equal(body.catalog.stale, false);

res = await get(app, "?refresh=true"); // now discovery breaks
assert.equal(res.status, 200, "failed refresh over a warm cache still serves results");
body = await res.json();
assert.equal(body.catalog.stale, true, "…but says so: stale=true");
assert.equal(body.catalog.source, "seed", "…and reports the curated seed, not hf+seed");
assert.equal(body.catalog.count, 2, "…serving the last-good catalog");
assert(body.results.length > 0, "user still gets recommendations offline");
console.log("SUGGEST DEGRADATION PASS ✅");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("SUGGEST PASS ✅");
