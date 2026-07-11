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
