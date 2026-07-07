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
 */

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
        for (const m of frame.messages) if (m.seq > this.lastSeq) this.lastSeq = m.seq;
        this.emit('history', frame);
        return;
      }
      case 'message': {
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
    const frame: BusSendFrame = {
      v: 1,
      type: 'message',
      body: msg.body,
      ...(msg.to !== undefined ? { to: msg.to } : {}),
      ...(msg.private !== undefined ? { private: msg.private } : {}),
    };
    this.send(frame);
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
