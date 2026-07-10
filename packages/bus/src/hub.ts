/**
 * The hub: live connections, per-channel rooms, routing, and work-status
 * presence. All identity fields on outbound frames (from, fromTokenId,
 * fromRole, workstatus handle, cancel by) are stamped HERE from the verified
 * token — nothing identity-like is ever copied from client input.
 */

import type { WebSocket } from 'ws';
import type {
  BusCancelFrame,
  BusMessageFrame,
  BusServerFrame,
  BusWorkStatusFrame,
} from '@maya-ai/core';
import type { BusDb, TokenRow } from './db.js';
import type { ClientFrame } from './frames.js';

export interface Conn {
  id: string;
  ws: WebSocket;
  channelId: string;
  handle: string;
  token: TokenRow;
}

interface WorkStatus {
  taskId: string;
  handle: string;
  state: NonNullable<BusWorkStatusFrame['state']>;
  task?: string;
  forWhom?: string;
  since: number;
  updatedAt: number;
}

const WORKSTATUS_TTL_MS = 60_000;

export class Hub {
  private readonly channels = new Map<string, Map<string, Conn>>();
  private readonly workStatuses = new Map<string, Map<string, WorkStatus>>(); // channelId → taskId → status
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly db: BusDb) {
    this.sweeper = setInterval(() => this.sweepWorkStatuses(), 15_000);
    this.sweeper.unref?.();
  }

  // ── membership ────────────────────────────────────────────────────────

  /** Allocate a channel-unique handle from the token label ("lead", "lead-2", …). */
  private allocateHandle(channelId: string, label: string): string {
    const room = this.channels.get(channelId);
    const taken = new Set([...(room?.values() ?? [])].map((c) => c.handle));
    if (!taken.has(label)) return label;
    for (let i = 2; ; i++) {
      const candidate = `${label}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  join(channelId: string, connId: string, ws: WebSocket, token: TokenRow): Conn {
    const room = this.channels.get(channelId) ?? new Map<string, Conn>();
    this.channels.set(channelId, room);
    const conn: Conn = { id: connId, ws, channelId, handle: this.allocateHandle(channelId, token.label), token };
    room.set(connId, conn);
    this.broadcast(channelId, { v: 1, type: 'system', event: 'participant_joined' }, conn.id);
    return conn;
  }

  leave(conn: Conn): void {
    const room = this.channels.get(conn.channelId);
    room?.delete(conn.id);
    if (room && room.size === 0) this.channels.delete(conn.channelId);
    this.broadcast(conn.channelId, { v: 1, type: 'system', event: 'participant_left' });
  }

  participants(channelId: string): Array<{ handle: string; tokenId: string; role: TokenRow['role'] }> {
    return [...(this.channels.get(channelId)?.values() ?? [])].map((c) => ({
      handle: c.handle,
      tokenId: c.token.id,
      role: c.token.role,
    }));
  }

  // ── frame handling ────────────────────────────────────────────────────

  /** Route one validated client frame. Returns an error string to send back, or null. */
  handle(conn: Conn, frame: ClientFrame): string | null {
    switch (frame.type) {
      case 'ping':
        this.sendTo(conn, { type: 'pong' });
        return null;
      case 'policy_ack':
        return null; // acknowledged; nothing to do in v1
      case 'message':
        return this.handleMessage(conn, frame);
      case 'workstatus':
        return this.handleWorkStatus(conn, frame);
      case 'cancel':
        return this.handleCancel(conn, frame);
    }
  }

  private handleMessage(
    conn: Conn,
    frame: Extract<ClientFrame, { type: 'message' }>,
  ): string | null {
    if (!conn.token.caps.includes('send')) return 'token lacks send capability';
    // Normalize: zod's .optional() yields `| undefined` props, the contract
    // (exactOptionalPropertyTypes) wants the keys absent instead.
    const body: BusMessageFrame['body'] = {
      ...(frame.body.text !== undefined ? { text: frame.body.text } : {}),
      ...(frame.body.maya !== undefined ? { maya: frame.body.maya } : {}),
      ...(frame.body.attachments !== undefined ? { attachments: frame.body.attachments } : {}),
      ...(frame.body.human !== undefined ? { human: frame.body.human } : {}),
    };
    const stamped = this.db.appendMessage(conn.channelId, {
      from: conn.handle,
      fromTokenId: conn.token.id,
      fromRole: conn.token.role,
      ...(frame.cid !== undefined ? { cid: frame.cid } : {}),
      to: frame.to ?? null,
      isPrivate: frame.private === true,
      body,
    });
    // null = at-least-once dedupe hit: the original of this resend was already
    // persisted and delivered — drop silently (no error, no redelivery).
    if (stamped) this.deliver(stamped);
    return null;
  }

  private handleWorkStatus(
    conn: Conn,
    frame: Extract<ClientFrame, { type: 'workstatus' }>,
  ): string | null {
    const channel = this.workStatuses.get(conn.channelId) ?? new Map<string, WorkStatus>();
    this.workStatuses.set(conn.channelId, channel);
    const existing = channel.get(frame.taskId);
    // Only the owning connection's handle may update its status.
    if (existing && existing.handle !== conn.handle) return 'workstatus owned by another handle';

    if (frame.action === 'clear' || frame.state === 'done' || frame.state === 'failed') {
      channel.delete(frame.taskId);
    } else {
      const now = Date.now();
      channel.set(frame.taskId, {
        taskId: frame.taskId,
        handle: conn.handle,
        state: frame.state ?? existing?.state ?? 'working',
        since: frame.since ?? existing?.since ?? now,
        updatedAt: now,
        ...(frame.task !== undefined ? { task: frame.task } : existing?.task !== undefined ? { task: existing.task } : {}),
        ...(frame.forWhom !== undefined
          ? { forWhom: frame.forWhom }
          : existing?.forWhom !== undefined
            ? { forWhom: existing.forWhom }
            : {}),
      });
    }
    this.broadcast(conn.channelId, this.workStatusFrame(conn.channelId, frame.taskId, frame, conn.handle));
    return null;
  }

  private handleCancel(conn: Conn, frame: Extract<ClientFrame, { type: 'cancel' }>): string | null {
    const original = this.db.messageBySeq(conn.channelId, frame.seq);
    if (!original) return 'no such message';
    const isAdmin = conn.token.caps.includes('admin');
    if (original.from !== conn.handle && !isAdmin) return 'only the sender or an admin can cancel';
    const out: BusCancelFrame = { v: 1, type: 'cancel', seq: frame.seq, by: conn.handle };
    this.broadcast(conn.channelId, out);
    return null;
  }

  // ── delivery ──────────────────────────────────────────────────────────

  /** Deliver a stamped message: broadcast, or sender+recipient only when private. */
  private deliver(msg: BusMessageFrame): void {
    const room = this.channels.get(msg.channelId);
    if (!room) return;
    for (const conn of room.values()) {
      if (msg.private === true) {
        const isParty = conn.handle === msg.from || conn.handle === msg.to;
        if (!isParty) continue;
      }
      this.sendTo(conn, msg);
    }
  }

  broadcast(channelId: string, frame: BusServerFrame, exceptConnId?: string): void {
    const room = this.channels.get(channelId);
    if (!room) return;
    for (const conn of room.values()) {
      if (exceptConnId !== undefined && conn.id === exceptConnId) continue;
      this.sendTo(conn, frame);
    }
  }

  sendTo(conn: Conn, frame: BusServerFrame | { type: 'pong' }): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(frame));
    } catch {
      // socket died mid-send; close handler will clean up
    }
  }

  // ── work-status upkeep ───────────────────────────────────────────────

  private workStatusFrame(
    channelId: string,
    taskId: string,
    frame: Extract<ClientFrame, { type: 'workstatus' }>,
    handle: string,
  ): BusWorkStatusFrame {
    const live = this.workStatuses.get(channelId)?.get(taskId);
    return {
      v: 1,
      type: 'workstatus',
      action: live ? frame.action : 'clear',
      taskId,
      handle,
      ...(live
        ? {
            state: live.state,
            since: live.since,
            ...(live.task !== undefined ? { task: live.task } : {}),
            ...(live.forWhom !== undefined ? { forWhom: live.forWhom } : {}),
          }
        : frame.state !== undefined
          ? { state: frame.state }
          : {}),
    };
  }

  private sweepWorkStatuses(): void {
    const now = Date.now();
    for (const [channelId, channel] of this.workStatuses) {
      for (const [taskId, status] of channel) {
        if (now - status.updatedAt > WORKSTATUS_TTL_MS) {
          channel.delete(taskId);
          this.broadcast(channelId, {
            v: 1,
            type: 'workstatus',
            action: 'clear',
            taskId,
            handle: status.handle,
            state: 'stale',
          });
        }
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
