/**
 * Maya contract: communication (Layer 4).
 *
 * We embed `@cana-ai/walkie-talkie` as the bus — Maya does NOT reinvent the
 * wire protocol. This file only pins the subset of frame shapes other Maya
 * layers rely on, plus Maya's channel-naming + token conventions.
 */

/** Channel naming: one channel per team, one per loop task fan-out. */
export type MayaChannelName =
  | `maya/team/${string}`   // long-lived team room
  | `maya/task/${string}`;  // per-task room the Loop lead opens & closes

export interface BusMessageFrame {
  v: 1;
  type: 'message';
  channelId: string;
  seq: number;
  from: string;
  /** Present iff sender is an agent token; humans have none. */
  fromTokenId?: string;
  /** Server-stamped role at send time (never trust text claims). */
  fromRole?: 'owner' | 'admin' | 'member';
  to?: string | null;
  private?: boolean;
  ts: string;
  body: {
    text?: string;
    /** Loop protocol payload when present — see loop.ts. */
    maya?: unknown;
    attachments?: Array<{ id: string; filename: string }>;
  };
}

export interface BusJoinedFrame {
  v: 1;
  type: 'joined';
  connectionId: string;
  handle: string;
  owner?: string;
  capabilities: Array<'receive' | 'send' | 'act' | 'admin'>;
}

/**
 * Token conventions:
 * - Maya mints one wtk_ token per spawned agent, scoped to exactly the
 *   channels that agent needs (team room + its task rooms).
 * - Worker tokens get receive+send only. The Loop lead's token also gets
 *   `act` IFF the owner enabled autonomous actions for that team.
 * - Tokens are passed to agent processes via env, never argv/logs.
 */
export const BUS_TOKEN_ENV = 'MAYA_BUS_TOKEN';
