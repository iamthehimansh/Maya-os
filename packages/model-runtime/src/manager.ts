import { EventEmitter } from "node:events";
import fs2 from "node:fs";
import net from "node:net";
import type {
  GuardrailPolicy,
  InstanceState,
  LocalModel,
  ModelId,
  ModelInstance,
  Quant,
  RuntimeEvent,
} from "@maya-ai/core";
import { detectLlamaCpp, llamaServerArgs } from "./backends/llamacpp.js";
import { estimateLoadBytes, planFit } from "./estimate.js";
import { availableRam, processRss } from "./ram.js";
import { findModel, quantLadderFrom, scanModels, writeModelMeta } from "./registry.js";
import { fileURLToPath } from "node:url";
import path2 from "node:path";

/**
 * Known-broken embedded chat templates, fixed by override. Qwen2.5-Coder
 * GGUFs ship a tool-call example with single braces where the Instruct
 * template has double — llama.cpp's chat-format detection fingerprints the
 * exact pattern, fails on the Coder variant, and silently disables native
 * tool calling (model answers in markdown JSON). One brace pair.
 */
const TEMPLATE_QUIRKS: Array<{ match: RegExp; templateFile: string }> = [
  {
    match: /^qwen2[.-]5-coder/i,
    templateFile: [
      path2.resolve(fileURLToPath(import.meta.url), "../../templates/qwen2.5-tools.jinja"), // monorepo dist
      path2.resolve(fileURLToPath(import.meta.url), "../templates/qwen2.5-tools.jinja"), // bundled: dist/../templates
    ].find((p) => fs2.existsSync(p)) ?? path2.resolve(fileURLToPath(import.meta.url), "../../templates/qwen2.5-tools.jinja"),
  },
];
import { InstanceSupervisor, type SupervisorEvent } from "./supervisor.js";

export interface LoadOpts {
  quant?: Quant;
  contextLength?: number;
  /** Skip the RAM-fit refusal — load even if it exceeds free RAM (macOS swaps
   *  to SSD). Owner-authorized overcommit; degrade ladder still applies. */
  force?: boolean;
}

interface Managed {
  instance: ModelInstance;
  supervisor: InstanceSupervisor;
  lastUsed: number;
}

const BASE_PORT = 41100; // instance ports live above the platform range

/**
 * The Runtime Manager — Maya's "never brick the Mac" layer. Owns every local
 * inference process; enforces GuardrailPolicy on load (RAM floor, degrade
 * ladder), during life (idle LRU), and on death (bounded restarts, via
 * InstanceSupervisor). Emits RuntimeEvents for the gateway's SSE stream.
 */
export class RuntimeManager extends EventEmitter {
  private readonly managed = new Map<string, Managed>(); // key: ModelId
  private lruTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly modelsDir: string,
    private readonly guardrails: GuardrailPolicy,
    private readonly idleUnloadAfterSec = 1800,
  ) {
    super();
  }

  private emitEvent(ev: RuntimeEvent): void {
    this.emit("event", ev);
  }

  instances(): ModelInstance[] {
    return [...this.managed.values()].map((m) => m.instance);
  }

  instanceFor(model: ModelId): ModelInstance | undefined {
    return this.managed.get(model)?.instance;
  }

  /** Mark activity so idle LRU doesn't reap a model mid-conversation. */
  touch(model: ModelId): void {
    const m = this.managed.get(model);
    if (m) m.lastUsed = Date.now();
  }

  /**
   * Load (idempotent): plan a fit within guardrails — degrade quant, then
   * context; if nothing fits after LRU-evicting idle instances, refuse with a
   * typed error. Never lets the host cross the free-RAM floor.
   */
  async load(model: ModelId, opts: LoadOpts = {}): Promise<ModelInstance> {
    const existing = this.managed.get(model);
    if (existing && existing.instance.state !== "stopped") {
      // Reuse only when the caller isn't asking for different params. A load
      // that requests a context or quant unlike what's live must RELOAD
      // (restart llama-server) — otherwise "load at 32k" over an 8k instance is
      // a silent no-op (observed: all-tools agents 400 because the requested
      // larger context never actually took effect).
      const ctxDiffers = opts.contextLength !== undefined && opts.contextLength !== existing.instance.contextLength;
      const quantDiffers = opts.quant !== undefined && opts.quant !== existing.instance.quant;
      if (!ctxDiffers && !quantDiffers) {
        existing.lastUsed = Date.now();
        return existing.instance;
      }
      await this.unload(model);
    }

    const local = findModel(this.modelsDir, model);
    if (!local) throw new Error(`model not installed: ${model} (maya models pull …)`);

    const llama = await detectLlamaCpp();
    if (!llama.installed || !llama.binPath) {
      throw new Error(`llama-server not found — ${llama.installHint ?? "install llama.cpp"}`);
    }

    const contextLength = opts.contextLength ?? local.contextLength;
    let plan = await this.planWithinBudget(local, opts.quant, contextLength);
    if (!plan) {
      // Try reclaiming RAM from idle instances before refusing
      const evicted = await this.evictIdle();
      if (evicted > 0) plan = await this.planWithinBudget(local, opts.quant, contextLength);
    }
    if (!plan) {
      if (opts.force) {
        // Owner-authorized overcommit: load anyway (macOS swaps to SSD). Use the
        // requested/best quant at the requested context; expect slow, not crash.
        const file0 = local.files.find((f) => f.quant === (opts.quant ?? local.files[0]?.quant)) ?? local.files[0]!;
        plan = {
          quant: file0.quant,
          fileBytes: file0.bytes,
          contextLength,
          estimateBytes: estimateLoadBytes(file0.bytes, contextLength),
          degraded: { quant: false, context: false },
        };
        this.emitEvent({ type: "ram_pressure", freeBytes: (await availableRam()).availableBytes, action: "none" });
      } else {
        const ram = await availableRam();
        this.emitEvent({ type: "ram_pressure", freeBytes: ram.availableBytes, action: "none" });
        throw new Error(
          `${model} cannot fit: ~${fmtGb(ram.availableBytes)} available after guardrail floor; ` +
            `smallest option needs more. Try a smaller model, close apps, or force-load (uses SSD as RAM).`,
        );
      }
    }

    if (plan.degraded.quant && opts.quant) {
      this.emitEvent({ type: "model_degraded", model, from: opts.quant, to: plan.quant, reason: "ram_pressure" });
    }

    const port = await freePort(BASE_PORT + this.managed.size);
    const file = local.files.find((f) => f.quant === plan.quant)!;
    // Speculative decoding: explicit draftModel in maya.json wins (false =
    // off); else auto-pair the smallest same-family model <=25% of the main
    // file. Draft startup failure (vocab mismatch) falls back to no-draft.
    const draft = this.resolveDraft(local);
    // mlock pins weights against swap — only when RAM is comfortable (>=20%
    // headroom over the estimate), so tight fits never fight the kernel.
    const ram = await availableRam();
    const comfortable = ram.availableBytes - this.guardrails.minFreeRamBytes >= plan.estimateBytes * 1.2;
    const extra = comfortable ? ["--mlock"] : [];
    const quirk = TEMPLATE_QUIRKS.find((q) => q.match.test(local.name));
    const argsFor = (opts2: { noMmap?: boolean; draft?: string }): string[] =>
      llamaServerArgs({
        modelPath: file.path,
        port,
        contextLength: plan.contextLength,
        alias: model,
        ...(quirk ? { chatTemplateFile: quirk.templateFile } : {}),
        ...(opts2.draft ? { draftPath: opts2.draft } : {}),
        extra: opts2.noMmap ? [...extra, "--no-mmap"] : extra,
      });
    // Fallback chain: with a draft, retry without it (vocab-mismatch is the
    // likely startup failure); without one, retry --no-mmap (mmap hang bug).
    const supervisor = new InstanceSupervisor({
      id: `${local.name}-${port}`,
      binPath: llama.binPath,
      args: argsFor(draft ? { draft } : {}),
      fallbackArgs: draft ? argsFor({}) : argsFor({ noMmap: true }),
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      healthCheckIntervalMs: this.guardrails.healthCheckIntervalMs,
      hungProcessTimeoutMs: this.guardrails.hungProcessTimeoutMs,
      maxRestarts: this.guardrails.maxRestarts,
      restartWindowMs: this.guardrails.restartWindowMs,
    });

    const instance: ModelInstance = {
      id: `mi_${Date.now().toString(36)}`,
      model,
      backend: "llama.cpp",
      state: "starting",
      port,
      pid: 0,
      quant: plan.quant,
      contextLength: plan.contextLength,
      memoryBytes: 0,
      startedAt: new Date().toISOString(),
    };
    const managed: Managed = { instance, supervisor, lastUsed: Date.now() };
    this.managed.set(model, managed);

    supervisor.on("event", (ev: SupervisorEvent) => {
      if (ev.type === "state") {
        instance.state = ev.state as InstanceState;
        instance.pid = supervisor.pid ?? instance.pid;
        this.emitEvent({
          type: "instance_state",
          instanceId: instance.id,
          model,
          state: instance.state,
          ...(ev.reason ? { reason: ev.reason } : {}),
        });
        if (ev.state === "stopped") this.managed.delete(model);
      } else if (ev.type === "restarted") {
        this.emitEvent({ type: "instance_restarted", instanceId: instance.id, model, attempt: ev.attempt });
      }
    });

    try {
      await supervisor.start();
    } catch (err) {
      this.managed.delete(model);
      throw err;
    }
    instance.pid = supervisor.pid ?? 0;
    if (plan.degraded.quant || plan.degraded.context) instance.state = "degraded";
    this.startLruSweep();
    void this.sampleRss(managed);
    if (local.toolCalling === undefined) void this.probeToolCalling(local.name, instance);
    return instance;
  }

  private async planWithinBudget(local: LocalModel, quant: Quant | undefined, contextLength: number) {
    const ram = await availableRam();
    // Reserve room for the speculation draft (if one will be paired) so the
    // main-model plan never overcommits.
    const draft = this.resolveDraft(local);
    const draftBytes = draft ? Math.round(fs2.statSync(draft).size * 1.15) : 0;
    const budget = ram.availableBytes - this.guardrails.minFreeRamBytes - draftBytes;
    if (budget <= 0) return null;
    return planFit(local.files, quant, contextLength, budget, quantLadderFrom);
  }

  /** Draft GGUF path for speculative decoding, or undefined. */
  private resolveDraft(local: LocalModel): string | undefined {
    if (local.draftModel === false) return undefined;
    const all = scanModels(this.modelsDir);
    if (typeof local.draftModel === "string") {
      const named = all.find((m) => m.name === local.draftModel);
      return named?.files[named.files.length - 1]?.path;
    }
    // MEASURED on Apple Silicon (llama.cpp Metal build 9890, q8 KV, 7B+0.5B):
    // draft-model speculation is a NET SLOWDOWN — best tuned config 0.83x
    // (n-max=10, p-min=0.9, 93% acceptance); untuned 0.48x. The old 1.00x
    // reading was worse than it looked: `--model-draft` alone never enabled
    // speculation (silent no-op without --spec-type), so nothing ran at all.
    // Root cause once it DOES run: Metal batch-verify of n+1 tokens costs ~n×
    // a single forward (compute-bound at batch), so it reclaims none of the
    // draft's sequential cost — acceptance is high but throughput still loses.
    // Byte-identical greedy also isn't guaranteed (rare tie-break divergence in
    // the batched q8-KV path). Auto-pairing is therefore OFF. Explicit maya.json
    // draftModel stays for backends where batch-verify IS free (CUDA) and for
    // EAGLE-3-via-MLX later (see docs/research/fast-low-resource-inference.md);
    // the flags are now correct (--spec-type + tuned p-min) so that path works.
    // Benchmark: packages/model-runtime/bench/spec-bench.mjs.
    return undefined;
  }

  async unload(model: ModelId): Promise<void> {
    const m = this.managed.get(model);
    if (!m) return;
    await m.supervisor.stop();
    this.managed.delete(model);
  }

  async unloadAll(): Promise<void> {
    await Promise.all([...this.managed.keys()].map((m) => this.unload(m as ModelId)));
    if (this.lruTimer) clearInterval(this.lruTimer);
    this.lruTimer = null;
  }

  /** Evict idle instances (oldest first); returns count evicted. */
  private async evictIdle(): Promise<number> {
    const idle = [...this.managed.entries()]
      .filter(([, m]) => Date.now() - m.lastUsed > 60_000)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    let evicted = 0;
    for (const [model] of idle) {
      const ram = await availableRam();
      this.emitEvent({ type: "ram_pressure", freeBytes: ram.availableBytes, action: "unload_lru" });
      await this.unload(model as ModelId);
      evicted++;
    }
    return evicted;
  }

  private startLruSweep(): void {
    if (this.lruTimer) return;
    this.lruTimer = setInterval(() => {
      void (async () => {
        for (const [model, m] of this.managed) {
          if (Date.now() - m.lastUsed > this.idleUnloadAfterSec * 1000) {
            await this.unload(model as ModelId);
          }
        }
      })();
    }, 60_000);
    this.lruTimer.unref?.();
  }

  /**
   * Measure native tool-calling once per model (persisted to maya.json).
   * Some models (e.g. the Qwen2.5-Coder series) answer tool requests in
   * markdown instead of native tool calls — orchestrators need the truth,
   * not the model card. One tiny probe at first ready; never repeated.
   */
  private async probeToolCalling(name: string, instance: ModelInstance): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "probe",
          max_tokens: 80,
          temperature: 0,
          messages: [{ role: "user", content: "Create a file hello.txt containing OK. Use the Write tool." }],
          tools: [{
            type: "function",
            function: {
              name: "Write",
              description: "Write a file",
              parameters: {
                type: "object",
                properties: { file_path: { type: "string" }, content: { type: "string" } },
                required: ["file_path", "content"],
              },
            },
          }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return; // inconclusive — leave unprobed for a retry next load
      const body = (await res.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
      const measured = Boolean(body.choices?.[0]?.message?.tool_calls?.length);
      writeModelMeta(this.modelsDir, name, { toolCalling: measured });
      this.emitEvent({ type: "instance_state", instanceId: instance.id, model: instance.model, state: instance.state, reason: `tool-calling probe: ${measured ? "native" : "NOT native (markdown fallback)"}` });
    } catch {
      // inconclusive — leave undefined so a later load retries
    }
  }

  private async sampleRss(m: Managed): Promise<void> {
    const timer = setInterval(() => {
      void (async () => {
        if (!this.managed.has(m.instance.model)) {
          clearInterval(timer);
          return;
        }
        if (m.instance.pid) m.instance.memoryBytes = await processRss(m.instance.pid);
      })();
    }, 10_000);
    timer.unref?.();
  }
}

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
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
  throw new Error("no free port for model instance");
}
