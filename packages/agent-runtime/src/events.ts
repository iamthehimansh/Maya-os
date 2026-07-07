/**
 * Per-agent event log: bounded ring buffer with monotonic cursors, readable
 * as an AsyncIterable that tails live events until the agent reaches a
 * terminal state (contracts: AgentAdapter.events(id, since?)).
 */

import type { AgentEvent } from '@maya-ai/core';

const MAX_EVENTS = 5000;

export class EventLog {
  private events: Array<{ cursor: number; event: AgentEvent }> = [];
  private nextCursor = 1;
  private waiters: Array<() => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    this.events.push({ cursor: this.nextCursor++, event });
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.wake();
  }

  /** Terminal state reached — tailing iterators finish after draining. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  snapshot(tail?: number): AgentEvent[] {
    const all = this.events.map((e) => e.event);
    return tail !== undefined && tail < all.length ? all.slice(all.length - tail) : all;
  }

  /** Tail events after `since` (opaque cursor from a prior iteration). */
  async *iterate(since?: string): AsyncIterable<{ cursor: string; event: AgentEvent }> {
    let from = since !== undefined ? Number(since) || 0 : 0;
    for (;;) {
      const pending = this.events.filter((e) => e.cursor > from);
      for (const e of pending) {
        from = e.cursor;
        yield { cursor: String(e.cursor), event: e.event };
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
