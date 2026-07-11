/**
 * TuiPermissionGate — the bridge between the agent loop's permission checks and
 * the interactive TUI.
 *
 * The loop is permission-agnostic: it constructs a `Session` with ONE
 * `PermissionGate` and calls `gate.request(req)` before every gated action
 * (writes, bash). This gate queues each request and hands it to whatever UI is
 * subscribed (the Ink App), then resolves the promise the loop is awaiting once
 * the user answers.
 *
 * Wiring (in cli.ts):
 *   const gate = new TuiPermissionGate();
 *   const session = createSession({ ..., permission: gate });
 *   runTui({ session, gate });
 *
 * In headless (`-p`) mode the CLI uses a different gate entirely; this one is
 * only for the interactive TUI.
 */
import type { PermissionGate, PermissionRequest } from '../types.js';

/** A permission request awaiting a decision, as surfaced to the UI. */
export interface PendingPermission {
  id: number;
  req: PermissionRequest;
  /** Called by the UI with the user's decision. */
  resolve(allow: boolean): void;
}

type Listener = (pending: PendingPermission | null) => void;

export class TuiPermissionGate implements PermissionGate {
  private seq = 0;
  private queue: PendingPermission[] = [];
  private listener: Listener | null = null;
  /** When true, every request is auto-allowed (`--yolo`). */
  private auto: boolean;

  constructor(opts: { autoAllow?: boolean } = {}) {
    this.auto = opts.autoAllow ?? false;
  }

  /** Loop-facing: await a decision for a gated action. */
  request(req: PermissionRequest): Promise<boolean> {
    if (this.auto) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const pending: PendingPermission = {
        id: ++this.seq,
        req,
        resolve: (allow: boolean) => {
          // Drop from the queue and surface the next one (if any).
          this.queue = this.queue.filter((p) => p.id !== pending.id);
          resolve(allow);
          this.emit();
        },
      };
      this.queue.push(pending);
      this.emit();
    });
  }

  /** UI-facing: subscribe to the head-of-queue pending request. */
  subscribe(listener: Listener): () => void {
    this.listener = listener;
    listener(this.current());
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** The request the UI should currently show, or null if the queue is empty. */
  current(): PendingPermission | null {
    return this.queue[0] ?? null;
  }

  /** Flip auto-allow at runtime (e.g. a `/yolo` toggle). */
  setAutoAllow(on: boolean): void {
    this.auto = on;
    if (on) {
      // Clear anything queued by allowing it.
      for (const p of [...this.queue]) p.resolve(true);
    }
  }

  get autoAllow(): boolean {
    return this.auto;
  }

  private emit(): void {
    this.listener?.(this.current());
  }
}
