/**
 * Maya contract: agent runtime (Layer 3). Owner: agent plane (01).
 *
 * One AgentAdapter per coding-agent product (Claude Code, Codex, OpenCode, …).
 * The orchestrator and dashboard speak ONLY these types; adapters translate
 * to each tool's real CLI/config underneath.
 *
 * Design rule: handles are PLAIN DATA, methods live on the adapter. The
 * orchestrator, CLI, and dashboard run in different processes — a handle must
 * survive JSON/HTTP/SQLite round-trips, so it cannot carry methods.
 */

import type { ModelId } from './models.js';

/** Open set: built-ins are literals, plugins register their own ids. */
export type AdapterId = 'claude-code' | 'codex' | 'opencode' | (string & {});

export type AgentState =
  | 'spawning'
  | 'running'
  | 'paused'
  | 'waiting_input' // blocked on a question (surfaced via AgentEvent kind:"question")
  | 'exited'        // finished on its own; exitCode set
  | 'killed'
  | 'failed';

export interface AgentSpawnSpec {
  adapter: AdapterId;
  /**
   * Which model serves this agent — ALWAYS a gateway ModelId, never a raw
   * URL/port. The adapter maps it to the tool's native config (e.g. Claude
   * Code: ANTHROPIC_BASE_URL → gateway's Anthropic-compat endpoint).
   */
  model: ModelId;
  /** Working directory the agent operates in (its repo/workspace). */
  cwd: string;
  /** The task prompt the agent starts with. */
  prompt?: string;
  /** Extra env for the agent process (never log values). */
  env?: Record<string, string>;
  /** Auto-join this walkie-talkie channel (token via env, never argv). */
  bus?: { wsBase: string; channelId: string; tokenEnv: string; handle?: string };
  /** "ask" = tool-permission prompts on; "auto" = adapter's skip-permissions mode. */
  permissionMode?: 'ask' | 'auto';
  /** Adapter-specific extras (auth method, CLI flags). Adapters validate. */
  options?: Record<string, unknown>;
}

/** Plain-data snapshot — serializable across HTTP/SQLite. */
export interface AgentHandle {
  id: string;          // "ag_<nanoid>", stable for the agent's lifetime
  adapter: AdapterId;
  state: AgentState;
  model: ModelId;
  cwd: string;
  pid?: number;
  busHandle?: string;  // the agent's handle on the bus channel, once joined
  spawnedAt: string;   // ISO 8601
  exitCode?: number;
}

export interface AgentLogEvent {
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

/** Structured events every adapter must emit (superset optional per adapter). */
export type AgentEvent =
  | { kind: 'state'; state: AgentState; at: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr' | 'system'; line: string; at: string }
  | { kind: 'question'; text: string; at: string }          // agent needs input
  | { kind: 'artifact'; path: string; note?: string; at: string }
  | { kind: 'tokens'; input: number; output: number; at: string }
  | { kind: 'error'; message: string; at: string };

/**
 * The adapter interface — the ONLY way the platform touches an agent process.
 * Methods take the handle id; all reject with typed errors, never throw sync.
 */
export interface AgentAdapter {
  readonly id: AdapterId;
  /** Is the underlying CLI installed + authed? Called before first spawn. */
  detect(): Promise<{ installed: boolean; version?: string; installHint?: string }>;
  spawn(spec: AgentSpawnSpec): Promise<AgentHandle>;
  pause(id: string): Promise<void>;   // SIGSTOP or adapter-native
  resume(id: string): Promise<void>;
  kill(id: string, graceMs?: number): Promise<void>;
  /** Deliver an answer/prompt to a running (or waiting_input) agent's stdin/PTY. */
  send(id: string, text: string): Promise<void>;
  status(id: string): Promise<AgentHandle>;
  /** Tail of structured events; `since` is an opaque cursor from a prior call. */
  events(id: string, since?: string): AsyncIterable<AgentEvent>;
  /** Raw log access for the dashboard (bounded; newest last). */
  logs(id: string, opts?: { tail?: number }): Promise<AgentLogEvent[]>;
}
