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
import { planFit } from "./estimate.js";
import { availableRam, processRss } from "./ram.js";
import { findModel, quantLadderFrom, scanModels } from "./registry.js";
import { InstanceSupervisor, type SupervisorEvent } from "./supervisor.js";

export interface LoadOpts {
  quant?: Quant;
  contextLength?: number;
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
      existing.lastUsed = Date.now();
      return existing.instance;
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
      const ram = await availableRam();
      this.emitEvent({ type: "ram_pressure", freeBytes: ram.availableBytes, action: "none" });
      throw new Error(
        `${model} cannot fit: ~${fmtGb(ram.availableBytes)} available after guardrail floor; ` +
          `smallest option needs more. Try a smaller model or close apps.`,
      );
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
    const argsFor = (opts2: { noMmap?: boolean; draft?: string }): string[] =>
      llamaServerArgs({
        modelPath: file.path,
        port,
        contextLength: plan.contextLength,
        alias: model,
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
    const family = local.name.split(/[-.]/)[0];
    if (!family) return undefined;
    const mainBytes = local.files[0]?.bytes ?? 0;
    const candidates = all
      .filter((m) => m.name !== local.name && m.name.split(/[-.]/)[0] === family)
      .map((m) => m.files[m.files.length - 1]!)
      .filter((f) => f.bytes <= mainBytes * 0.25)
      .sort((a, b) => a.bytes - b.bytes);
    return candidates[0]?.path;
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
