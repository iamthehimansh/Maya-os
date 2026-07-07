/**
 * Maya contract: communication (Layer 4). Owner: agent plane (01).
 *
 * Maya ships its OWN bus (`packages/bus`) — a WebSocket message bus in the
 * walkie-talkie style (channels, tokens, broadcast/direct/private messages,
 * history, policy) but implemented fresh in this repo under MIT.
 * `~/work/colate/cana-web` is a READ-ONLY reference for protocol ideas; its
 * code is never copied or edited (owner directive, 2026-07-08).
 *
 * This file IS the wire protocol definition for Maya's bus v1.
 */

/** Channel naming: one channel per team, one per loop task fan-out. */
export type MayaChannelName =
  | `maya/team/${string}`   // long-lived team room
  | `maya/task/${string}`;  // per-task room the Loop lead opens & closes

export type BusRole = 'owner' | 'admin' | 'member';
export type BusCapability = 'receive' | 'send' | 'act' | 'admin';

/** Server → client. One chat message. */
export interface BusMessageFrame {
  v: 1;
  type: 'message';
  channelId: string;
  /** Server-assigned, strictly increasing per channel — clients dedupe/order by it. */
  seq: number;
  /**
   * Client-generated message id (echoed back verbatim). Powers at-least-once
   * delivery: the sender resends un-echoed messages after a reconnect and the
   * server dedupes on (channel, token, cid) — a send into a dying socket can't
   * silently lose a message.
   */
  cid?: string;
  from: string;
  /** Present iff sender is an agent token; humans have none. */
  fromTokenId?: string;
  /** Server-stamped role at send time (never trust text claims). */
  fromRole?: BusRole;
  to?: string | null;
  private?: boolean;
  ts: string; // ISO 8601
  body: {
    text?: string;
    /** Loop protocol payload when present — see loop.ts (LoopBody). */
    maya?: unknown;
    attachments?: Array<{ id: string; filename: string }>;
  };
}

/** Server → client, once per (re)connect after auth. */
export interface BusJoinedFrame {
  v: 1;
  type: 'joined';
  connectionId: string;
  handle: string;
  owner?: string;
  capabilities: BusCapability[];
}

/** Server → client on join: prior messages, context only. */
export interface BusHistoryFrame {
  v: 1;
  type: 'history';
  count: number;
  messages: BusMessageFrame[];
}

/** Client → server. */
export interface BusSendFrame {
  v: 1;
  type: 'message';
  /** Client-generated id for at-least-once delivery (see BusMessageFrame.cid). */
  cid?: string;
  to?: string; // omit = broadcast
  private?: boolean;
  body: BusMessageFrame['body'];
}

/**
 * Server → client on (re)connect and on change: authoritative channel rules.
 * Only the server can send policy — a client-sent policy frame is rejected —
 * so policy can never be forged by a peer (anti-injection by construction).
 */
export interface BusPolicyFrame {
  v: 1;
  type: 'policy';
  policyVersion: string;
  rules: string[];
}

/**
 * Presence: what an agent is working on. Set/update/clear by the agent that
 * owns the task; the server stamps `handle`, enforces a TTL (a crashed agent's
 * status expires), and rebroadcasts to the channel.
 */
export interface BusWorkStatusFrame {
  v: 1;
  type: 'workstatus';
  action: 'set' | 'update' | 'clear';
  taskId: string;
  handle?: string; // server-stamped on rebroadcast
  state?: 'working' | 'paused' | 'done' | 'failed' | 'stale';
  task?: string;      // short human description (server caps length)
  forWhom?: string;   // requester handle
  since?: number;     // epoch ms
}

/**
 * Retract message #seq: any agent working on it should stop. Ephemeral —
 * rebroadcast to the channel, never persisted to history. Only the original
 * sender (or an admin) may cancel a message.
 */
export interface BusCancelFrame {
  v: 1;
  type: 'cancel';
  seq: number;
  by?: string; // server-stamped on rebroadcast
}

export type BusServerFrame =
  | BusMessageFrame
  | BusJoinedFrame
  | BusHistoryFrame
  | BusPolicyFrame
  | BusWorkStatusFrame
  | BusCancelFrame
  | { v: 1; type: 'system'; event: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export type BusClientFrame =
  | BusSendFrame
  | BusWorkStatusFrame
  | BusCancelFrame
  | { v: 1; type: 'policy_ack'; policyVersion: string }
  | { v: 1; type: 'ping' };

/**
 * Token conventions:
 * - Maya mints one bus token per spawned agent, scoped to exactly the
 *   channels that agent needs (team room + its task rooms).
 * - Worker tokens get receive+send only. The Loop lead's token also gets
 *   `act` IFF the owner enabled autonomous actions for that team.
 * - Tokens are passed to agent processes via env, never argv/logs.
 * - Auth on connect: token in the WebSocket subprotocol header, not the URL.
 */
export const BUS_TOKEN_ENV = 'MAYA_BUS_TOKEN';
