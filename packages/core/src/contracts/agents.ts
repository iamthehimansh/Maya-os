/**
 * Maya contract: agent runtime (Layer 3).
 *
 * One AgentAdapter per coding-agent product (Claude Code, Codex, OpenCode, …).
 * The orchestrator and dashboard speak ONLY these types; adapters translate
 * to each tool's real CLI/config underneath.
 */

import type { ModelId } from './models.js';

export type AgentKind = 'claude-code' | 'codex' | 'opencode' | 'custom';

export type AgentState =
  | 'spawning'
  | 'running'
  | 'paused'
  | 'waiting_input' // blocked on a question (surfaced via AgentEvent kind:"question")
  | 'exited'        // finished on its own; exitCode set
  | 'killed'
  | 'failed';

export interface AgentSpawnSpec {
  kind: AgentKind;
  /** Which model serves this agent — ALWAYS a gateway ModelId, never a raw URL. */
  model: ModelId;
  /** Working directory the agent operates in (its repo/workspace). */
  cwd: string;
  /** The task prompt the agent starts with. */
  prompt: string;
  /** Bus channel the agent must join for coordination (see bus.ts). */
  busChannelId?: string;
  /** Adapter-specific extras (auth method, CLI flags, env). Adapters validate. */
  options?: Record<string, unknown>;
}

export interface AgentHandle {
  id: string;          // maya-assigned, stable for the agent's lifetime
  kind: AgentKind;
  state: AgentState;
  model: ModelId;
  cwd: string;
  pid?: number;
  busHandle?: string;  // the agent's handle on the bus channel, once joined
  spawnedAt: string;   // ISO 8601
  exitCode?: number;
}

/** Structured events every adapter must emit (superset optional per adapter). */
export type AgentEvent =
  | { kind: 'state'; state: AgentState; at: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string; at: string }
  | { kind: 'question'; text: string; at: string }          // agent needs input
  | { kind: 'artifact'; path: string; note?: string; at: string }
  | { kind: 'tokens'; input: number; output: number; at: string }
  | { kind: 'error'; message: string; at: string };

/**
 * The adapter interface — the ONLY way the platform touches an agent process.
 * All methods reject with a typed Error subclass on failure; none of them
 * throw synchronously.
 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Verify the underlying CLI exists + auth works. Called before first spawn. */
  preflight(): Promise<{ ok: boolean; detail?: string }>;
  spawn(spec: AgentSpawnSpec): Promise<AgentHandle>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  /** Deliver an answer/prompt to a running (or waiting_input) agent. */
  send(id: string, text: string): Promise<void>;
  status(id: string): Promise<AgentHandle>;
  /** Tail of structured events; `since` is an opaque cursor from a prior call. */
  events(id: string, since?: string): AsyncIterable<AgentEvent>;
  /** Raw log access for the dashboard (bounded; newest last). */
  logs(id: string, opts?: { limit?: number }): Promise<string[]>;
}
