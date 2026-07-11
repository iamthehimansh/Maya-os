/**
 * Maya contract: persistent multi-agent teams on the bus (himansh's vision —
 * Maya's teams work like the walkie-talkie system itself).
 *
 * Drafted by 02 (owns the MCP `spawn_agent` + this spec); 01 shapes the
 * spawn-path + persistent-agent lifecycle to match. A Team is a Lead + N
 * persistent workers sharing ONE bus channel: they @tag each other + the human,
 * post multimedia, and a monitor wakes whoever's addressed.
 */

import type { AdapterId } from "./agents.js";
import type { ModelId } from "./models.js";

/**
 * A persistent, addressable agent. `handle` is how everyone (@mentions), the
 * monitor (wake target), and the bus (routing) refer to it.
 *
 * HANDLE RULES (the thing to nail):
 * - **Caller-provided, orchestrator-enforced.** The lead (via MCP `spawn_agent`)
 *   or the human (via the team UI) PROVIDES the desired handle. The
 *   orchestrator validates it and REJECTS a duplicate within the team (the
 *   caller picks another) — handles are unique per team/channel, never
 *   auto-suffixed silently.
 * - Format: `@` + `[a-z0-9][a-z0-9-]{0,30}` (lowercase, kebab). `@lead` is
 *   RESERVED for the team's lead; workers may not claim it.
 * - Stable for the agent's lifetime; freed when the agent is stopped.
 */
export interface AgentSpec {
  handle: string; // "@backend", "@qa" — unique within the team
  type: AdapterId; // "claude-code" | "codex" | "opencode" | "mayac" (maya code)
  model: ModelId; // served via the gateway; prefer toolCalling=true for workers
  cwd: string; // working directory
  role?: "lead" | "worker"; // default "worker"; exactly one "lead" per team
  systemPrompt?: string; // persona/instructions
  allowedTools?: string[]; // tool scope; ["*"] or omitted = ALL tools (full freedom)
  /** Run this agent on a cldz saved auth profile (owner's real Claude — cloud
   * Opus/Sonnet) instead of the local gateway. The profile NAME only (e.g.
   * "god"); credentials are resolved server-side and never leave the machine. */
  cldzProfile?: string;
  /** Run the agent's NATIVE interactive TUI in a real PTY (watchable live in the
   * dashboard terminal) instead of the headless one-shot path. Messages are typed
   * into the terminal; chat output flows via the outbox file. Supported by
   * "claude-code" and "mayac" — the two types with a real TUI. */
  pty?: boolean;
  /** Run the agent on the OWNER's own subscription login instead of the Maya
   * gateway (adapter-side seam, same as cldzProfile): `claude login` creds for
   * "claude-code", `codex login` for "codex", and for "mayac" its own
   * `--auth subscription` resolution (~/.claude or ~/.codex, per provider). */
  auth?: "claude-subscription" | "codex-subscription" | "mayac-subscription";
}

/** A team = one lead + N workers, all persistent + parallel, sharing a channel. */
export interface TeamSpec {
  name: string;
  channelId: string; // the shared bus room (e.g. "maya/team/<id>")
  lead: AgentSpec; // role forced to "lead", handle "@lead"
  workers: AgentSpec[]; // spawned + live in parallel; grown at runtime via MCP
  tokenBudget?: number;
}

/**
 * LEAST-CAPABILITY TOKEN (the other thing to nail):
 * On spawn, the orchestrator mints ONE bus token per agent, scoped to EXACTLY
 * that agent's team channel, with capabilities **['receive','send'] only** —
 * `receive` is required just to JOIN, `send` to talk; NEVER `act`/`admin`. The
 * token is passed to the agent process via env (`MAYA_BUS_TOKEN`), never argv,
 * and REVOKED when the agent is stopped or the team drains. The lead gets the
 * same least-capability token as workers — spawning power comes from the MCP
 * tool (a separate, orchestrator-mediated seam), not from a privileged bus token.
 *
 * WHAT THE LEAD DECIDES (himansh: "let lead decide"): the bus TOKEN stays
 * least-capability for everyone (messaging only — a security floor). What the
 * lead chooses per agent is that agent's TOOL scope — `allowedTools` on the
 * AgentSpec it spawns (Write/Edit/Bash/…). That's the agent's real capability
 * (what it can DO on the system); the orchestrator caps it to the team policy.
 */
export const AGENT_BUS_CAPS = ["receive", "send"] as const;
export const RESERVED_LEAD_HANDLE = "@lead";
export const HANDLE_RE = /^@[a-z0-9][a-z0-9-]{0,30}$/;

/** Live view of an agent (what list_agents / the team UI show). */
export interface AgentStatus {
  handle: string;
  type: AdapterId;
  model: ModelId;
  role: "lead" | "worker";
  cwd: string; // working directory — shown in the team's full-info view
  allowedTools?: string[]; // the tool scope the lead granted this agent
  state: "spawning" | "live" | "working" | "stopped" | "failed";
  pid?: number;
  lastMessageAt?: string; // for the team page's activity display
}
