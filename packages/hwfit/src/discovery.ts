import type { Quant } from "@maya-ai/core";
import type { CatalogModel } from "./types.js";

/**
 * Live model discovery from the HuggingFace API.
 *
 * The curated seed ages the moment it's written — a model released next week
 * will never appear in it. Discovery keeps the recommender current without a
 * release: query HF for popular GGUF repos, parse what we can, and merge.
 *
 * Everything here degrades to nothing: if HF is unreachable (offline, rate
 * limited, on a plane), discovery returns [] and the seed carries the feature.
 * A model recommender that breaks without internet would be a bad joke.
 */

const QUANTS: Quant[] = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** Injectable so tests can mock the network without touching HF. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface HfSibling {
  rfilename: string;
}
interface HfModel {
  id: string;
  downloads?: number;
  tags?: string[];
  siblings?: HfSibling[];
}

export interface DiscoverOptions {
  /** How many repos to pull from HF. */
  limit?: number;
  /** Restrict to code-oriented repos (the default use case). */
  search?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Parameter count from a repo name: "Qwen2.5-Coder-7B-Instruct" → 7.
 *
 * The `2.5` in "Qwen2.5" must NOT be read as 2.5B, so the digits have to be
 * followed by a B at a token boundary.
 */
export function parseParamsB(repoName: string): number | undefined {
  const m = /(?:^|[-_/\s])(\d+(?:\.\d+)?)\s*b(?=$|[-_.\s])/i.exec(repoName);
  return m ? Number(m[1]) : undefined;
}

/**
 * MoE active params from the "-A3B" convention: "Qwen3-30B-A3B" → 3 active of
 * 30 total. That suffix is the only reliable in-name signal that a repo is MoE.
 */
export function parseActiveParamsB(repoName: string): number | undefined {
  const m = /[-_]a(\d+(?:\.\d+)?)\s*b(?=$|[-_.\s])/i.exec(repoName);
  return m ? Number(m[1]) : undefined;
}

/** Resolve quant → real filename. Never templated: repos disagree on casing. */
export function resolveGgufFiles(files: string[]): Partial<Record<Quant, string>> {
  const out: Partial<Record<Quant, string>> = {};
  for (const quant of QUANTS) {
    const exact = new RegExp(`[-._]${quant}\\.gguf$`, "i");
    const hit = files.find((f) => exact.test(f) && !SPLIT_RE.test(f));
    if (hit) {
      out[quant] = hit;
      continue;
    }
    const split = files.find((f) =>
      new RegExp(`[-._]${quant}-00001-of-\\d{5}\\.gguf$`, "i").test(f),
    );
    if (split) out[quant] = split;
  }
  return out;
}

/** A stable slug for `local/<name>`: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF" → "qwen2.5-coder-7b". */
export function slugFor(repoId: string): string {
  const repo = repoId.split("/")[1] ?? repoId;
  return repo
    .replace(/-?GGUF$/i, "")
    .replace(/-?Instruct$/i, "")
    .toLowerCase();
}

/**
 * The HF orgs that publish their OWN models. Ownership of the repo is the only
 * claim about lineage that a stranger cannot forge by choosing a filename.
 *
 * Deliberately NOT a list of good quantizers. `bartowski`, `mradermacher` and
 * `TheBloke` are reputable and prolific — and they quantize whatever is
 * popular, slop merges included. Trusting them tells you the binary is probably
 * safe to download; it tells you nothing about whether the model is any good.
 * Those are different questions (see `verified` in types.ts).
 */
const UPSTREAM_OWNERS = new Set([
  "qwen",
  "deepseek-ai",
  "meta-llama",
  "google",
  "mistralai",
  "microsoft",
  "ibm-granite",
  "allenai",
  "nvidia",
  "01-ai",
  "thudm",
  "openai",
]);

/** True when the repo is owned by the org that actually made the model. */
export function isUpstreamOwner(repoId: string): boolean {
  const owner = repoId.split("/")[0]?.toLowerCase() ?? "";
  return UPSTREAM_OWNERS.has(owner);
}

/**
 * HuggingFace publishes a model's ancestry in its tags, and it is far better
 * evidence than anything we can infer from a repo name:
 *
 *   base_model:quantized:Qwen/Qwen3-Coder-30B-A3B-Instruct   ← a repack of a real Qwen
 *   base_model:adapter:Jackrong/Qwopus3.5-9B-v3.5            ← a derivative of its own author
 *
 * It ships in the payload we already fetch, so reading it costs nothing.
 */
export interface BaseModel {
  owner: string;
  repo: string;
  /** "quantized" | "adapter" | "merge" | "finetune" | "" (bare base_model:owner/repo). */
  relation: string;
}

export function parseBaseModel(tags: string[] = []): BaseModel | undefined {
  // Prefer the qualified form (`base_model:quantized:owner/repo`) — the bare
  // form appears alongside it and carries no relation.
  const qualified = tags.find((t) => /^base_model:[a-z]+:.+\/.+/i.test(t));
  const bare = tags.find((t) => /^base_model:[^:]+\/[^:]+$/i.test(t));
  const tag = qualified ?? bare;
  if (!tag) return undefined;

  const parts = tag.split(":");
  const ref = parts[parts.length - 1] ?? "";
  const relation = parts.length >= 3 ? (parts[1]?.toLowerCase() ?? "") : "";
  const [owner, repo] = ref.split("/");
  if (!owner || !repo) return undefined;
  return { owner, repo, relation };
}

/**
 * Strip packaging noise so a repack's name can be compared to its base's.
 *
 * Stripped in a LOOP, not a fixed order: repos stack the suffixes in whatever
 * order they like (`…-Instruct-MLX-6bit`, `…-Instruct-6bit-MLX`, `…-i1-GGUF`),
 * and a single pass leaves the leftovers behind — which then fails the name
 * match and quietly marks a legitimate repack (`lmstudio-community`) unverified.
 */
const PACKAGING_SUFFIX = /[-_.]?(gguf|mlx|safetensors|\d+bit|bf16|fp16|i1|imatrix|q\d[_a-z0-9]*)$/i;

function normaliseName(name: string): string {
  let out = name.toLowerCase();
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(PACKAGING_SUFFIX, "");
  }
  return out.replace(/[^a-z0-9]/g, "");
}

/**
 * Can we vouch for this model's LINEAGE — is it what it says it is?
 *
 * Two ways to earn it, and only two:
 *  1. The repo is owned by the upstream org itself (`Qwen/…`, `google/…`).
 *  2. It is a straight QUANTIZATION of an upstream model, per HF's own
 *     `base_model` tag, AND its name still matches that base.
 *
 * (2) is what rescues the real ecosystem: `TheBloke`, `unsloth` and
 * `MaziyarPanahi` don't train models, they repack real ones, and calling them
 * "unverified" would have libelled most of local-LLM land. It's gated on the
 * NAME still matching because the tag alone is forgeable and, more commonly,
 * sloppy: `yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1` tags itself
 * `quantized:google/gemma-4-12B-it`, but the extra words (`coder`, `fable5`,
 * `composer2.5`) betray a MERGE — a derivative whose quality is nobody's but
 * its author's. Google's Gemma 4 is real (2.8M downloads, released 2026-05-23);
 * this thing is a community remix of it, and only the remix is unverified.
 *
 * `adapter` / `merge` / `finetune` relations never verify, whatever the base:
 * inheriting weights is not inheriting a reputation.
 */
export function isVerifiedLineage(repoId: string, tags: string[] = []): boolean {
  if (isUpstreamOwner(repoId)) return true;

  const base = parseBaseModel(tags);
  if (!base) return false;
  if (!UPSTREAM_OWNERS.has(base.owner.toLowerCase())) return false;
  // A repack, not a derivative. "" (bare tag) is too weak to trust.
  if (base.relation !== "quantized") return false;

  const repoName = repoId.split("/")[1] ?? "";
  return normaliseName(repoName) === normaliseName(base.repo);
}

function providerFor(repoId: string, name: string): string {
  const s = `${repoId} ${name}`.toLowerCase();
  if (s.includes("qwen")) return "qwen";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("llama")) return "meta";
  if (s.includes("mistral") || s.includes("codestral")) return "mistral";
  if (s.includes("gemma")) return "google";
  if (s.includes("phi")) return "microsoft";
  return "community";
}

/** Best-effort architecture tag — feeds the recency bonus in score.ts. */
function archFor(name: string): string {
  const s = name.toLowerCase();
  if (s.includes("qwen3")) return "qwen3";
  if (s.includes("qwen2.5")) return "qwen2.5";
  if (s.includes("deepseek-r1") || s.includes("r1-distill")) return "deepseek-r1";
  if (s.includes("llama-3.3") || s.includes("llama3.3")) return "llama3.3";
  if (s.includes("llama-3.2") || s.includes("llama3.2")) return "llama3.2";
  if (s.includes("llama-3.1") || s.includes("llama3.1")) return "llama3.1";
  if (s.includes("gemma-3") || s.includes("gemma3")) return "gemma3";
  if (s.includes("phi-4") || s.includes("phi4")) return "phi4";
  return "unknown";
}

/** Turn one HF repo into a CatalogModel, or null when we can't trust the parse. */
export function toCatalogModel(hf: HfModel): CatalogModel | null {
  const repoName = hf.id.split("/")[1] ?? hf.id;
  const paramsB = parseParamsB(repoName);
  // No parseable size → no memory estimate → no honest recommendation. Skip it
  // rather than invent a number.
  if (!paramsB) return null;

  const files = (hf.siblings ?? []).map((s) => s.rfilename).filter((f) => f.endsWith(".gguf"));
  const ggufFiles = resolveGgufFiles(files);
  if (!Object.keys(ggufFiles).length) return null;

  const activeParamsB = parseActiveParamsB(repoName);
  const tags = (hf.tags ?? []).join(" ").toLowerCase();
  const coding = /cod(e|ing)/i.test(repoName) || tags.includes("code");

  return {
    name: slugFor(hf.id),
    displayName: repoName.replace(/-?GGUF$/i, "").replace(/-/g, " "),
    provider: providerFor(hf.id, repoName),
    paramsB,
    ...(activeParamsB !== undefined ? { activeParamsB } : {}),
    isMoe: activeParamsB !== undefined,
    arch: archFor(repoName),
    // HF's API doesn't expose trained context in the model index; 32k is the
    // modern floor and the fit planner only ever shrinks from here.
    contextLength: 32768,
    coding,
    hfRepo: hf.id,
    ggufFiles,
    // Upstream-owned, or a straight quantization of an upstream model per HF's
    // own base_model tag. Never inferred from the repo NAME — a name is a string
    // anyone can type.
    verified: isVerifiedLineage(hf.id, hf.tags ?? []),
  };
}

/**
 * Query HF for GGUF repos. Returns [] on ANY failure — offline is a normal
 * state for a local-first tool, not an error worth surfacing.
 */
export async function discoverModels(opts: DiscoverOptions = {}): Promise<CatalogModel[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 30;
  const search = opts.search ?? "coder";
  const url =
    `https://huggingface.co/api/models?filter=gguf&search=${encodeURIComponent(search)}` +
    `&sort=downloads&direction=-1&limit=${limit}&full=true`;

  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as HfModel[];
    if (!Array.isArray(body)) return [];

    const out: CatalogModel[] = [];
    for (const hf of body) {
      const model = toCatalogModel(hf);
      if (model) out.push(model);
    }
    return out;
  } catch {
    return [];
  }
}

// ── MLX (Apple Silicon native) ──────────────────────────────────────────────
//
// MLX is packaged nothing like GGUF. GGUF puts every quant in ONE repo and you
// pick a *file*; MLX ships one REPO per quant (`…-MLX-4bit`, `…-MLX-8bit`) full
// of sharded safetensors. So discovery here resolves repo ids, not filenames,
// and has to GROUP the per-quant repos back into a single model.
//
// Nothing Maya can run today loads MLX — `llamacpp.ts` is the only backend, and
// it is GGUF-only. So an MLX-only find is deliberately surfaced as INFORMATION
// (`sources.gguf: null` → the gateway marks it `runnable: false`) and never as
// a Download button that would 404 the user. When an MLX backend lands, the
// catalog is already carrying the repos.

/** MLX bit-width → the nearest quant on Maya's ladder, by bits-per-weight. */
const MLX_BITS_TO_QUANT: Record<number, Quant> = {
  3: "Q3_K_M",
  4: "Q4_K_M",
  5: "Q5_K_M",
  6: "Q6_K",
  8: "Q8_0",
  16: "F16",
};

/** "Qwen2.5-Coder-7B-Instruct-4bit" → 4; "…-bf16" → 16. Undefined = not MLX-quantised. */
export function parseMlxBits(repoName: string): number | undefined {
  if (/[-_](bf16|fp16|f16)$/i.test(repoName)) return 16;
  const m = /[-_](\d+)\s*bit$/i.exec(repoName);
  if (!m) return undefined;
  const bits = Number(m[1]);
  return MLX_BITS_TO_QUANT[bits] ? bits : undefined;
}

/** MLX bits → the ladder quant we'll size and score it as. */
export function mlxQuantFor(bits: number): Quant | undefined {
  return MLX_BITS_TO_QUANT[bits];
}

/**
 * A slug that COLLIDES ON PURPOSE with the GGUF one.
 *
 * `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` and
 * `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF` are the same model in two packagings,
 * so both must slug to `qwen2.5-coder-7b` — that collision is what lets the
 * catalog ATTACH the MLX repo to the model the user can already download,
 * instead of listing the same model twice.
 */
export function mlxSlugFor(repoId: string): string {
  const repo = repoId.split("/")[1] ?? repoId;
  return repo
    .replace(/[-_](?:\d+bit|bf16|fp16|f16)$/i, "")
    .replace(/-?MLX$/i, "")
    .replace(/-?Instruct$/i, "")
    .toLowerCase();
}

/** One MLX repo → a catalog entry carrying no GGUF (hence: not runnable today). */
export function toMlxCatalogModel(hf: HfModel): CatalogModel | null {
  const repoName = hf.id.split("/")[1] ?? hf.id;
  const bits = parseMlxBits(repoName);
  const quant = bits ? mlxQuantFor(bits) : undefined;
  // No parseable bit-width → we cannot size it → we will not guess at it.
  if (!quant) return null;

  const paramsB = parseParamsB(repoName);
  if (!paramsB) return null;

  const activeParamsB = parseActiveParamsB(repoName);
  const tags = (hf.tags ?? []).join(" ").toLowerCase();
  const coding = /cod(e|ing)/i.test(repoName) || tags.includes("code");

  return {
    name: mlxSlugFor(hf.id),
    // Strip the bit-width FIRST — plenty of repos end in `-8bit` with no `MLX`
    // in the name, and leaving it in puts "…composer2.5 8bit" on the card while
    // the quant is shown separately (and may not even be the 8-bit one).
    displayName: repoName
      .replace(/[-_](?:\d+bit|bf16|fp16|f16)$/i, "")
      .replace(/-?MLX$/i, "")
      .replace(/-/g, " ")
      .trim(),
    provider: providerFor(hf.id, repoName),
    paramsB,
    ...(activeParamsB !== undefined ? { activeParamsB } : {}),
    isMoe: activeParamsB !== undefined,
    arch: archFor(repoName),
    contextLength: 32768,
    coding,
    hfRepo: hf.id,
    // Empty ON PURPOSE: there is no GGUF here, so `sources.gguf` resolves to
    // null and the gateway reports the pick as `runnable: false`.
    ggufFiles: {},
    mlxRepo: hf.id,
    mlxQuants: { [quant]: hf.id },
    verified: isVerifiedLineage(hf.id, hf.tags ?? []),
  };
}

/**
 * Discover MLX repos and GROUP the per-quant repos into one model each.
 *
 * `…-MLX-4bit`, `…-MLX-6bit` and `…-MLX-8bit` are three repos describing one
 * model, so returning them as three catalog entries would show the user the
 * same model three times. They're folded into a single entry whose `mlxQuants`
 * spans every published bit-width.
 */
export async function discoverMlxModels(opts: DiscoverOptions = {}): Promise<CatalogModel[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 30;
  const search = opts.search ?? "coder";
  const url =
    `https://huggingface.co/api/models?filter=mlx&search=${encodeURIComponent(search)}` +
    `&sort=downloads&direction=-1&limit=${limit}&full=true`;

  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as HfModel[];
    if (!Array.isArray(body)) return [];

    const bySlug = new Map<string, CatalogModel>();
    for (const hf of body) {
      const model = toMlxCatalogModel(hf);
      if (!model) continue;

      const existing = bySlug.get(model.name);
      if (!existing) {
        bySlug.set(model.name, model);
        continue;
      }
      // Same model, another bit-width: fold this repo into the quants we know.
      const quants = { ...existing.mlxQuants, ...model.mlxQuants };
      existing.mlxQuants = quants;
      // 4-bit is the config people actually run on a laptop, so it wins the
      // "preferred repo" slot when it shows up.
      const preferred = quants.Q4_K_M;
      if (preferred) existing.mlxRepo = preferred;
    }
    return [...bySlug.values()];
  } catch {
    return [];
  }
}
