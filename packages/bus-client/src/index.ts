/**
 * Maya bus client SDK.
 *
 * Reliability lives HERE so agents don't hand-roll it:
 * - auto-reconnect with exponential backoff + jitter (1s → 30s cap)
 * - outbound queue: send() while offline buffers and flushes IN ORDER on
 *   reconnect — a send is never silently lost (queue bound: 1000)
 * - seq dedupe: live messages replayed by the server after a reconnect are
 *   dropped; history arrives once per (re)join as a separate 'history' event
 * - policy auto-ack, app-level keepalive ping
 *
 * Token is passed in the WS subprotocol (`mbt.<token>`) — never in the URL.
 *
 * USAGE RULE: attach event handlers BEFORE calling connect(). Multiple server
 * frames (joined → policy → history) can arrive in one TCP segment and fire
 * synchronously back-to-back — a handler attached after `await`ing 'joined'
 * can miss the history frame that came in the same batch.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  BusCancelFrame,
  BusHistoryFrame,
  BusJoinedFrame,
  BusMessageFrame,
  BusPolicyFrame,
  BusSendFrame,
  BusServerFrame,
  BusWorkStatusFrame,
} from '@maya-ai/core';

export interface BusClientOptions {
  /** e.g. "ws://127.0.0.1:4300" */
  wsBase: string;
  channelId: string;
  /** The mbt_… secret. */
  token: string;
  /** Keepalive ping cadence (ms); 0 disables. Default 25s. */
  pingIntervalMs?: number;
}

export interface BusClientEvents {
  joined: (frame: BusJoinedFrame) => void;
  message: (frame: BusMessageFrame) => void;
  history: (frame: BusHistoryFrame) => void;
  policy: (frame: BusPolicyFrame) => void;
  workstatus: (frame: BusWorkStatusFrame) => void;
  cancel: (frame: BusCancelFrame) => void;
  system: (frame: { v: 1; type: 'system'; event: string }) => void;
  error: (err: { code: string; message: string }) => void;
  open: () => void;
  close: () => void;
}

type EventName = keyof BusClientEvents;

const MAX_QUEUE = 1000;
const BACKOFF_CAP_MS = 30_000;

export class BusClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<EventName, Set<(arg: never) => void>>();
  private readonly outQueue: string[] = [];
  /**
   * At-least-once delivery for message frames: every sendMessage() gets a cid
   * and stays here until the server ECHOES it back (the echo is the ack —
   * ws.send() succeeding proves nothing; a socket can die mid-flight and
   * black-hole the frame). On every reconnect all still-pending messages are
   * resent first, in order; the server dedupes on (channel, token, cid).
   */
  private readonly pendingMessages = new Map<string, string>(); // cid → serialized frame
  private attempts = 0;
  private stopped = false;
  private lastSeq = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Handle assigned by the server on join (null until first 'joined'). */
  handle: string | null = null;

  constructor(private readonly opts: BusClientOptions) {}

  // ── events ────────────────────────────────────────────────────────────

  on<E extends EventName>(event: E, fn: BusClientEvents[E]): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn as (arg: never) => void);
    this.listeners.set(event, set);
    return this;
  }

  off<E extends EventName>(event: E, fn: BusClientEvents[E]): this {
    this.listeners.get(event)?.delete(fn as (arg: never) => void);
    return this;
  }

  private emit<E extends EventName>(event: E, ...args: Parameters<BusClientEvents[E]>): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as unknown as (...a: Parameters<BusClientEvents[E]>) => void)(...args);
      } catch {
        // a listener throwing must not kill the socket loop
      }
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  connect(): this {
    this.stopped = false;
    this.open();
    return this;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    const url = `${this.opts.wsBase.replace(/\/$/, '')}/ws/bus/${encodeURIComponent(this.opts.channelId)}`;
    const ws = new WebSocket(url, [`mbt.${this.opts.token}`]);
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      // Un-acked messages first, in original order — the server dedupes by
      // cid, so resending one that actually landed is harmless.
      for (const json of this.pendingMessages.values()) {
        try {
          ws.send(json);
        } catch {
          break; // socket died again; next reconnect retries
        }
      }
      this.flush();
      this.emit('open');
    });

    ws.on('message', (data) => this.onFrame(data));

    ws.on('close', () => {
      this.emit('close');
      if (this.stopped) return;
      const delay = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** this.attempts) + Math.floor(Math.random() * 500);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => this.open(), delay);
      this.reconnectTimer.unref?.();
    });

    ws.on('error', () => {
      // close event follows; backoff handles retry
    });

    const cadence = this.opts.pingIntervalMs ?? 25_000;
    if (cadence > 0 && !this.pingTimer) {
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ v: 1, type: 'ping' }));
        }
      }, cadence);
      this.pingTimer.unref?.();
    }
  }

  private onFrame(data: WebSocket.RawData): void {
    let frame: BusServerFrame | { type: 'pong' };
    try {
      frame = JSON.parse(String(data)) as BusServerFrame | { type: 'pong' };
    } catch {
      return;
    }
    switch (frame.type) {
      case 'pong':
        return;
      case 'joined':
        this.handle = frame.handle;
        this.emit('joined', frame);
        return;
      case 'policy':
        this.send({ v: 1, type: 'policy_ack', policyVersion: frame.policyVersion });
        this.emit('policy', frame);
        return;
      case 'history': {
        for (const m of frame.messages) {
          if (m.seq > this.lastSeq) this.lastSeq = m.seq;
          // A pending message appearing in history means it landed before the
          // disconnect — that's our ack.
          if (m.cid !== undefined) this.pendingMessages.delete(m.cid);
        }
        this.emit('history', frame);
        return;
      }
      case 'message': {
        // The server echoing our cid back IS the delivery ack.
        if (frame.cid !== undefined) this.pendingMessages.delete(frame.cid);
        if (frame.seq <= this.lastSeq) return; // dedupe replays across reconnects
        this.lastSeq = frame.seq;
        this.emit('message', frame);
        return;
      }
      case 'workstatus':
        this.emit('workstatus', frame);
        return;
      case 'cancel':
        this.emit('cancel', frame);
        return;
      case 'system':
        this.emit('system', frame);
        return;
      case 'error':
        this.emit('error', { code: frame.code, message: frame.message });
        return;
    }
  }

  // ── sending ───────────────────────────────────────────────────────────

  /** Queue a raw frame; flushes immediately when the socket is open. */
  private send(frame: object): void {
    if (this.outQueue.length >= MAX_QUEUE) this.outQueue.shift();
    this.outQueue.push(JSON.stringify(frame));
    this.flush();
  }

  private flush(): void {
    while (this.outQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const next = this.outQueue[0];
      if (next === undefined) break;
      try {
        this.ws.send(next);
        this.outQueue.shift();
      } catch {
        break; // stays queued; retried on next open
      }
    }
  }

  /** Broadcast text, or pass a full send-frame shape for to/private/maya bodies. */
  say(text: string): void {
    this.sendMessage({ body: { text } });
  }

  sendMessage(msg: { to?: string; private?: boolean; body: BusSendFrame['body'] }): void {
    const cid = randomUUID();
    const frame: BusSendFrame = {
      v: 1,
      type: 'message',
      cid,
      body: msg.body,
      ...(msg.to !== undefined ? { to: msg.to } : {}),
      ...(msg.private !== undefined ? { private: msg.private } : {}),
    };
    const json = JSON.stringify(frame);
    // Tracked until the server echoes the cid back (see pendingMessages doc).
    if (this.pendingMessages.size >= MAX_QUEUE) {
      const oldest = this.pendingMessages.keys().next().value;
      if (oldest !== undefined) this.pendingMessages.delete(oldest);
    }
    this.pendingMessages.set(cid, json);
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(json);
      } catch {
        // stays pending; resent on next open
      }
    }
  }

  workStatus(status: Omit<BusWorkStatusFrame, 'v' | 'type' | 'handle'>): void {
    this.send({ v: 1, type: 'workstatus', ...status });
  }

  cancel(seq: number): void {
    this.send({ v: 1, type: 'cancel', seq });
  }

  /** Highest message seq seen (live or history) — persist to resume catch-up reads. */
  get seq(): number {
    return this.lastSeq;
  }
}
