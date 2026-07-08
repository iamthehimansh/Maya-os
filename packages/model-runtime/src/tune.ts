import net from "node:net";
import type { LocalModel, Quant } from "@maya-ai/core";
import { detectLlamaCpp, llamaServerArgs } from "./backends/llamacpp.js";
import { QUANT_QUALITY, estimateLoadBytes } from "./estimate.js";
import { availableRam } from "./ram.js";
import { InstanceSupervisor } from "./supervisor.js";

/**
 * maya tune — find the (quant × context × draft) configuration that yields the
 * most generation tokens/second while still fitting in RAM, MEASURED on the
 * host rather than guessed. The estimator (estimate.ts) answers "will it fit?";
 * the tuner answers "of the things that fit, which is fastest?" — a question
 * only a real llama-server on this exact Mac can answer (memory bandwidth,
 * Metal graph, KV quant, draft acceptance all vary per machine).
 */

/** One point in the search space: a quant + context, optionally with a draft. */
export interface TuneCandidate {
  quant: Quant;
  contextLength: number;
  /** Draft model name for speculative decoding, or undefined for no draft. */
  draft?: string;
  draftPath?: string;
  fileBytes: number;
  /** Conservative RAM estimate (weights + buffers + KV + draft), planning bytes. */
  estimateBytes: number;
}

/** A smaller model offered as a speculative-decoding draft for the main model. */
export interface DraftOption {
  name: string;
  path: string;
  bytes: number;
}

export interface BuildSearchSpaceOpts {
  /** Quants to consider (default: every quant installed on disk). */
  quants?: Quant[];
  /** Smallest context worth serving — configs below this are excluded so the
   *  objective can't degenerate to "ctx=2048 is fastest". Default 8192 (the
   *  agent floor: agents send 20k+ prompts, a 2k window is a lie). */
  minCtx: number;
  /** Largest context to try — capped at the model's trained context. */
  targetCtx: number;
  /** RAM available for the instance (already net of the guardrail floor). */
  budgetBytes: number;
  /** Draft models to pair-test (each becomes its own candidate set). */
  drafts?: DraftOption[];
}

/**
 * Enumerate every (quant × context × draft) config that FITS the RAM budget.
 * Pure and deterministic so it can be unit-tested without a GPU. Contexts step
 * down by halves from targetCtx to minCtx; the caller benches each survivor.
 */
export function buildSearchSpace(
  files: LocalModel["files"],
  opts: BuildSearchSpaceOpts,
): TuneCandidate[] {
  const byQuant = new Map(files.map((f) => [f.quant, f]));
  const quants = (opts.quants ?? files.map((f) => f.quant)).filter((q) => byQuant.has(q));

  const ctxSteps: number[] = [];
  const top = Math.max(opts.minCtx, Math.min(opts.targetCtx, opts.targetCtx));
  for (let ctx = top; ctx >= opts.minCtx; ctx = Math.floor(ctx / 2)) ctxSteps.push(ctx);
  if (ctxSteps[ctxSteps.length - 1] !== opts.minCtx) ctxSteps.push(opts.minCtx);

  // Draft reserve mirrors the manager's planWithinBudget: file × 1.15 for the
  // draft's own weights + small KV. undefined = the "no draft" baseline.
  const draftOpts: Array<DraftOption | undefined> = [undefined, ...(opts.drafts ?? [])];

  const out: TuneCandidate[] = [];
  for (const quant of quants) {
    const f = byQuant.get(quant)!;
    for (const ctx of ctxSteps) {
      for (const draft of draftOpts) {
        const draftBytes = draft ? Math.round(draft.bytes * 1.15) : 0;
        const est = estimateLoadBytes(f.bytes, ctx) + draftBytes;
        if (est > opts.budgetBytes) continue;
        out.push({
          quant,
          contextLength: ctx,
          ...(draft ? { draft: draft.name, draftPath: draft.path } : {}),
          fileBytes: f.bytes,
          estimateBytes: est,
        });
      }
    }
  }
  // Bench order: highest quality × largest context first, so an interrupted run
  // still has tried the "nice" configs. Final ranking is by measured tok/s.
  return out.sort(
    (a, b) =>
      (QUANT_QUALITY[b.quant] ?? 0.9) - (QUANT_QUALITY[a.quant] ?? 0.9) ||
      b.contextLength - a.contextLength,
  );
}

/** Measured result for one candidate (ok=false when it failed to serve). */
export interface TuneResult {
  candidate: TuneCandidate;
  /** Generation throughput — the number `maya tune` maximizes. */
  genTokPerSec: number;
  /** Prefill throughput (prompt tokens/sec) — how fast it ingests context. */
  promptTokPerSec: number;
  /** Time from spawn to first healthy probe (cold load cost). */
  loadMs: number;
  ok: boolean;
  error?: string;
}

/** A fixed, deterministic prompt that exercises real prefill + generation. */
const BENCH_PROMPT =
  "You are a helpful coding assistant. Explain, step by step and in detail, how a " +
  "hash map resolves collisions, why load factor matters, and how resizing works. " +
  "Then describe the trade-offs between open addressing and separate chaining. ";

export interface BenchOpts {
  binPath: string;
  modelPath: string;
  candidate: TuneCandidate;
  /** Tokens to generate in the measured pass (default 128). */
  genTokens?: number;
  chatTemplateFile?: string;
  startupTimeoutMs?: number;
}

/**
 * Spawn one real llama-server at this candidate's quant/context/draft, warm it,
 * then time a fixed generation with `ignore_eos` so exactly `genTokens` tokens
 * are produced — throughput comes straight from llama.cpp's own `timings`
 * (predicted_per_second), the same numbers the server reports internally. The
 * server is always torn down before returning.
 */
export async function benchCandidate(opts: BenchOpts): Promise<TuneResult> {
  const { candidate } = opts;
  const genTokens = opts.genTokens ?? 128;
  const base: TuneResult = { candidate, genTokPerSec: 0, promptTokPerSec: 0, loadMs: 0, ok: false };

  const port = await freePort(45100);
  const supervisor = new InstanceSupervisor({
    id: `tune-${candidate.quant}-${candidate.contextLength}-${port}`,
    binPath: opts.binPath,
    args: llamaServerArgs({
      modelPath: opts.modelPath,
      port,
      contextLength: candidate.contextLength,
      ...(candidate.draftPath ? { draftPath: candidate.draftPath } : {}),
      ...(opts.chatTemplateFile ? { chatTemplateFile: opts.chatTemplateFile } : {}),
    }),
    port,
    healthUrl: `http://127.0.0.1:${port}/health`,
    healthCheckIntervalMs: 5_000,
    hungProcessTimeoutMs: 60_000,
    maxRestarts: 0, // a crash during a bench = candidate fails, don't thrash
    restartWindowMs: 60_000,
    startupTimeoutMs: opts.startupTimeoutMs ?? 120_000,
  });

  try {
    const t0 = Date.now();
    await supervisor.start();
    base.loadMs = Date.now() - t0;

    // Warm-up: compiles the Metal graph / primes caches so the measured pass
    // reflects steady-state throughput, not first-token compilation.
    await complete(port, 16);
    const timings = await complete(port, genTokens);
    base.genTokPerSec = round1(timings.predicted_per_second);
    base.promptTokPerSec = round1(timings.prompt_per_second);
    base.ok = base.genTokPerSec > 0;
    return base;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  } finally {
    await supervisor.stop(2_000).catch(() => {});
  }
}

interface LlamaTimings {
  prompt_per_second: number;
  predicted_per_second: number;
}

/** Hit llama.cpp's native /completion with ignore_eos so it emits exactly n tokens. */
async function complete(port: number, nPredict: number): Promise<LlamaTimings> {
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: BENCH_PROMPT,
      n_predict: nPredict,
      temperature: 0,
      ignore_eos: true, // force exactly n_predict tokens → a stable measurement
      cache_prompt: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`/completion HTTP ${res.status}`);
  const body = (await res.json()) as { timings?: Partial<LlamaTimings> };
  const t = body.timings;
  if (!t || typeof t.predicted_per_second !== "number") {
    throw new Error("llama-server returned no timings (unexpected build?)");
  }
  return { prompt_per_second: t.prompt_per_second ?? 0, predicted_per_second: t.predicted_per_second };
}

export interface TuneReport {
  model: string;
  ramAvailableBytes: number;
  ramBudgetBytes: number;
  minCtx: number;
  targetCtx: number;
  /** Every candidate benched, sorted fastest-first (ok results before failures). */
  results: TuneResult[];
  /** The fastest config that met the minimum-context constraint, or null. */
  best: TuneResult | null;
}

export interface TuneOpts extends Partial<BuildSearchSpaceOpts> {
  /** RAM floor to keep free (bytes). Default 2 GiB — matches guardrail default. */
  minFreeRamBytes?: number;
  genTokens?: number;
  /** Progress callback: fires before each candidate and after each result. */
  onProgress?: (ev: TuneEvent) => void;
}

export type TuneEvent =
  | { kind: "plan"; candidates: number }
  | { kind: "bench"; index: number; total: number; candidate: TuneCandidate }
  | { kind: "result"; index: number; total: number; result: TuneResult };

const MIB = 1024 * 1024;

/**
 * Full tune: measure the RAM budget now, build the fitting search space, bench
 * every candidate on a real llama-server, and rank by generation tok/s. Returns
 * the optimal config plus the whole measured table (so the speed/quality/context
 * trade is visible, not just the winner).
 */
export async function tuneModel(
  modelsDir: string,
  local: LocalModel,
  drafts: DraftOption[],
  opts: TuneOpts = {},
): Promise<TuneReport> {
  const llama = await detectLlamaCpp();
  if (!llama.installed || !llama.binPath) {
    throw new Error(`llama-server not found — ${llama.installHint ?? "install llama.cpp"}`);
  }

  const ram = await availableRam();
  const minFree = opts.minFreeRamBytes ?? 2 * 1024 * MIB;
  const budget = Math.max(0, ram.availableBytes - minFree);
  const targetCtx = Math.min(opts.targetCtx ?? 32768, local.contextLength);
  const minCtx = Math.min(opts.minCtx ?? 8192, targetCtx);

  const space = buildSearchSpace(local.files, {
    ...(opts.quants ? { quants: opts.quants } : {}),
    minCtx,
    targetCtx,
    budgetBytes: budget,
    drafts: opts.drafts ?? drafts,
  });
  opts.onProgress?.({ kind: "plan", candidates: space.length });

  const results: TuneResult[] = [];
  for (let i = 0; i < space.length; i++) {
    const candidate = space[i]!;
    const file = local.files.find((f) => f.quant === candidate.quant)!;
    opts.onProgress?.({ kind: "bench", index: i, total: space.length, candidate });
    const result = await benchCandidate({
      binPath: llama.binPath,
      modelPath: file.path,
      candidate,
      ...(opts.genTokens ? { genTokens: opts.genTokens } : {}),
    });
    results.push(result);
    opts.onProgress?.({ kind: "result", index: i, total: space.length, result });
  }

  // Rank: successful benches by tok/s desc, failures last.
  results.sort((a, b) => Number(b.ok) - Number(a.ok) || b.genTokPerSec - a.genTokPerSec);
  const best = results.find((r) => r.ok) ?? null;

  return {
    model: local.name,
    ramAvailableBytes: ram.availableBytes,
    ramBudgetBytes: budget,
    minCtx,
    targetCtx,
    results,
    best,
  };
}

async function freePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free port for tune bench");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
