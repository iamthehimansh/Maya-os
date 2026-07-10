import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { InstanceState } from "@maya-ai/core";
import { logsDir } from "@maya-ai/core";

export interface SupervisorOpts {
  id: string;
  binPath: string;
  args: string[];
  port: number;
  /** Health endpoint considered ready when it returns 200. */
  healthUrl: string;
  healthCheckIntervalMs: number;
  hungProcessTimeoutMs: number;
  maxRestarts: number;
  restartWindowMs: number;
  /** How long to wait for readiness before declaring startup failed. */
  startupTimeoutMs?: number;
  /**
   * Args for a one-shot startup retry (e.g. with --no-mmap: mmap loads are
   * near-instant but hang on some Apple Silicon setups — a startup timeout
   * gets ONE retry with the fallback before giving up).
   */
  fallbackArgs?: string[];
}

export type SupervisorEvent =
  | { type: "state"; state: InstanceState; reason?: string }
  | { type: "restarted"; attempt: number }
  | { type: "log"; line: string };

/**
 * Supervises ONE llama-server (or any HTTP-health child): spawn → readiness →
 * health polling → hung/crash handling → bounded restarts with backoff.
 * Guardrail stance: a child may die; the host must not even notice.
 */
export class InstanceSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: InstanceState = "stopped";
  private healthTimer: NodeJS.Timeout | null = null;
  private lastHealthy = 0;
  private restarts: number[] = []; // timestamps within window
  private stopping = false;
  private usedFallback = false;
  private logStream: fs.WriteStream | null = null;

  constructor(private readonly opts: SupervisorOpts) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get currentState(): InstanceState {
    return this.state;
  }

  private setState(state: InstanceState, reason?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("event", { type: "state", state, ...(reason ? { reason } : {}) } satisfies SupervisorEvent);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error(`instance ${this.opts.id} already running`);
    this.stopping = false;
    this.setState("starting");

    fs.mkdirSync(logsDir(), { recursive: true });
    this.logStream = fs.createWriteStream(path.join(logsDir(), `${this.opts.id}.log`), { flags: "a" });

    const child = spawn(this.opts.binPath, this.usedFallback && this.opts.fallbackArgs ? this.opts.fallbackArgs : this.opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    this.child = child;

    // Orphan guard: if THIS process exits for any reason that still runs exit
    // handlers (clean exit, uncaught exception), take the child with us. A
    // SIGKILL'd parent still leaks — the Phase 5 supervisor watchdog closes
    // that hole; this closes the common one (a crashed test/CLI).
    const killChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    process.once("exit", killChild);
    child.once("exit", () => process.removeListener("exit", killChild));

    const onLine = (buf: Buffer): void => {
      const line = buf.toString();
      this.logStream?.write(line);
      // llama-server logs are chatty; only surface error-ish lines as events
      if (/error|failed|out of memory|abort/i.test(line)) {
        this.emit("event", { type: "log", line: line.trim().slice(0, 400) } satisfies SupervisorEvent);
      }
    };
    child.stdout?.on("data", onLine);
    child.stderr?.on("data", onLine);

    child.on("exit", (code, signal) => {
      this.child = null;
      this.stopHealthLoop();
      if (this.stopping) {
        this.setState("stopped");
        return;
      }
      // Unexpected death → bounded restart with backoff
      void this.handleCrash(`exit code=${code} signal=${signal}`);
    });

    const ready = await this.waitReady(this.opts.startupTimeoutMs ?? 120_000);
    if (!ready) {
      await this.stop(0);
      if (!this.usedFallback && this.opts.fallbackArgs) {
        // Known failure mode: mmap load hangs on some setups. One retry
        // with the fallback args (--no-mmap) before declaring failure.
        this.usedFallback = true;
        this.stopping = false;
        this.emit("event", { type: "log", line: "startup timed out — retrying with fallback args (--no-mmap)" } satisfies SupervisorEvent);
        await this.start();
        return;
      }
      this.setState("stopped", "startup timeout");
      throw new Error(`instance ${this.opts.id} failed to become ready`);
    }
    this.lastHealthy = Date.now();
    this.setState("ready");
    this.startHealthLoop();
  }

  private async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) return false; // died during startup
      if (await this.probe()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async probe(): Promise<boolean> {
    try {
      const res = await fetch(this.opts.healthUrl, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private startHealthLoop(): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(() => {
      void (async () => {
        if (!this.child) return;
        if (await this.probe()) {
          this.lastHealthy = Date.now();
          if (this.state === "unhealthy") this.setState("ready", "recovered");
          return;
        }
        const sinceHealthy = Date.now() - this.lastHealthy;
        if (sinceHealthy > this.opts.hungProcessTimeoutMs) {
          // Hung: no successful probe within budget → SIGKILL; exit handler restarts.
          this.setState("unhealthy", "hung — killing");
          this.child.kill("SIGKILL");
        } else if (sinceHealthy > this.opts.healthCheckIntervalMs * 2) {
          this.setState("unhealthy", "failing health checks");
        }
      })();
    }, this.opts.healthCheckIntervalMs);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private async handleCrash(reason: string): Promise<void> {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < this.opts.restartWindowMs);
    if (this.restarts.length >= this.opts.maxRestarts) {
      this.setState("stopped", `gave up after ${this.restarts.length} restarts (${reason})`);
      return;
    }
    this.restarts.push(now);
    const attempt = this.restarts.length;
    const backoffMs = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
    this.setState("starting", `restarting after crash (${reason})`);
    await new Promise((r) => setTimeout(r, backoffMs));
    if (this.stopping) return;
    try {
      await this.start();
      this.emit("event", { type: "restarted", attempt } satisfies SupervisorEvent);
    } catch {
      // start() already emitted terminal state
    }
  }

  /** Graceful stop: SIGTERM, then SIGKILL after graceMs. Idempotent. */
  async stop(graceMs = 5_000): Promise<void> {
    this.stopping = true;
    this.stopHealthLoop();
    const child = this.child;
    if (!child) {
      this.setState("stopped");
      return;
    }
    this.setState("stopping");
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once("exit", () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      // Wait for the exit event (it nulls this.child + flips state to stopped)
      // — returning early left this.child set, so the --no-mmap fallback
      // retry's start() threw "already running" and the stale exit handler
      // could crash-respawn an untracked llama-server.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((r) => child.once("exit", () => r()));
      }
    }
    this.logStream?.end();
    this.logStream = null;
  }
}
