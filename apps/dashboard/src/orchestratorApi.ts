/** Thin client over the orchestrator service (proxied same-origin like /api). */

export interface Team {
  id: string;
  name: string;
  topology: string;
  channelId: string;
  tokenBudget: number | null;
  tokensUsed: number;
  state: "active" | "draining" | "closed";
  createdAt: string;
  inFlight: number;
  /** Server-reported liveness (manager.isLive) — the source of truth for LIVE badges. */
  live?: boolean;
}

/**
 * A team handed off from the Teams page to the Chat page: which bus channel to
 * load into the stream, and whether the team is still live (composer active) or
 * closed (read-only history). This is the seam himansh asked for — click a team,
 * land in Chat connected to it.
 */
export interface OpenTeam {
  id: string;
  channelId: string;
  name: string;
  live: boolean;
}

export interface Task {
  id: string;
  teamId: string;
  spec: string;
  state: "queued" | "assigned" | "accepted" | "working" | "blocked" | "done" | "failed";
  assignee: string | null;
  attempts: number;
  result: string | null;
  updatedAt: string;
}

export interface Run {
  runId: string;
  goal: string;
  state: "running" | "done";
  startedAt: string;
  report?: { outcome: string; summary: string; questionsAsked: number };
}

/** One live milestone from a run's SSE stream. */
export interface LoopEvent {
  kind: "started" | "planned" | "question" | "verified" | "rework" | "goal_check" | "report";
  at: string;
  tasks?: number;
  taskId?: string;
  ok?: boolean;
  feedback?: string;
  round?: number;
  met?: boolean;
  missing?: string[];
  prompt?: string;
  outcome?: string;
  summary?: string;
  tokensUsed?: number;
  /** question events only: id to answer with + the tap-able options */
  qid?: string;
  options?: Array<{ id: string; label: string }>;
  /** started event only: the team channel this run speaks on */
  channelId?: string;
}

export interface StartLoopInput {
  goal: string;
  cwd: string;
  leadModel: string;
  workerModel?: string;
  teamId?: string;
  allowedTools?: string[];
  tokenBudget?: number;
}

export interface CreateTeamInput {
  name: string;
  workerModel: string;
  cwd: string;
  allowedTools?: string[];
  tokenBudget?: number;
}

/** Extract a human-readable error from any of the three servers' shapes:
 * orchestrator `{error: string}`, gateway/proxy `{error: {message, type}}`. */
const errText = (body: unknown, status: number): string => {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return `HTTP ${status}`;
};

const get = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(errText(await res.json().catch(() => null), res.status));
  return res.json() as Promise<T>;
};

export const getTeams = (liveOnly = false): Promise<Team[]> => get(`/api/teams${liveOnly ? "?live=1" : ""}`);
export const getTeamTasks = (teamId: string): Promise<Task[]> => get(`/api/teams/${encodeURIComponent(teamId)}/tasks`);
export const getRuns = (): Promise<Run[]> => get("/api/runs");

export async function startLoop(input: StartLoopInput): Promise<{ runId: string }> {
  return postJson("/api/loop", input);
}

export async function createTeam(input: CreateTeamInput): Promise<Team> {
  return postJson("/api/teams", {
    name: input.name,
    members: [{ model: input.workerModel, cwd: input.cwd, ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}) }],
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
  });
}

export const drainTeam = (teamId: string): Promise<Response> =>
  fetch(`/api/teams/${encodeURIComponent(teamId)}/drain`, { method: "POST" });

/** Archive a finished team — deletes the team row, its tasks, and its standing-agent
 * specs. The server answers 409 while the team is still live. */
export async function deleteTeam(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(errText(await res.json().catch(() => null), res.status));
}

// ── Persistent bus agents (the multi-agent path) ───────────────────────────
// These are addressable @handle agents that live on the team's bus channel —
// spawned, @mentioned, and replied-to. Shared by SoloView (02) + team-chat (01).

export interface SpawnAgentInput {
  handle: string; // "@builder" — unique within the team
  type: "claude-code" | "codex" | "opencode";
  model: string; // gateway ModelId, e.g. "local/qwen2.5-7b-instruct"
  cwd: string;
  role?: "lead" | "worker";
  systemPrompt?: string;
  allowedTools?: string[]; // omitted or ["*"] = all tools (full freedom)
  cldzProfile?: string; // cldz auth profile — run on real Claude/Codex (see api.getCldzProfiles)
  /** Run a real interactive PTY (the actual Claude TUI) instead of headless -p.
   * Omitted = server default (PTY for standing agents); false opts out. */
  pty?: boolean;
}

export interface AgentStatus {
  handle: string;
  type: string;
  model: string;
  role: "lead" | "worker";
  cwd: string;
  allowedTools?: string[];
  state: "spawning" | "live" | "working" | "stopped" | "failed";
  pid?: number;
  lastMessageAt?: string;
}

/** One message as stored on a bus channel (what the chat panes render). */
export interface ChannelMessage {
  seq: number;
  from: string;
  to?: string;
  ts: string;
  fromTokenId?: string; // present ⇒ an agent/token sender; absent ⇒ a human
  body: { text?: string; maya?: unknown; human?: boolean };
}

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(errText(await res.json().catch(() => null), res.status));
  return res.json() as Promise<T>;
};

/** Spawn a persistent, addressable agent into a team (it joins the bus channel). */
export const spawnTeamAgent = (teamId: string, agent: SpawnAgentInput): Promise<AgentStatus> =>
  postJson(`/api/teams/${encodeURIComponent(teamId)}/agents`, { agent });

/** Live roster of a team's persistent agents. */
export const getTeamAgents = (teamId: string): Promise<AgentStatus[]> => get(`/api/teams/${encodeURIComponent(teamId)}/agents`);

/** Retire an agent — revokes its bus token and kills its tracked process. */
export const stopTeamAgent = (teamId: string, handle: string): Promise<Response> =>
  fetch(`/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(handle)}`, { method: "DELETE" });

/** Post to the team channel; `to` directs it at an @handle (wakes that agent).
 * `human` marks it as the owner's own message so the UI renders it as "You". */
export const sendTeamMessage = (teamId: string, text: string, to?: string, human?: boolean): Promise<unknown> =>
  postJson(`/api/teams/${encodeURIComponent(teamId)}/messages`, { text, ...(to ? { to } : {}), ...(human ? { human: true } : {}) });

/** Read a bus channel's recent history (GET-only proxy; the chat stream).
 * `after` is a seq cursor — pass the last seen seq to fetch only newer messages,
 * so pollers append instead of re-reading (and freezing at) a fixed window. */
export const getChannelHistory = (channelId: string, limit = 60, after?: number): Promise<{ messages: ChannelMessage[] }> =>
  get(`/api/channels/${encodeURIComponent(channelId)}/history?limit=${limit}${after ? `&after=${after}` : ""}`);

/** Answer a loop that's waiting on a proactive question (routes over the bus). */
export async function answerRun(runId: string, answer: { qid?: string; optionId?: string; text?: string }): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(answer),
  });
  if (!res.ok) throw new Error(errText(await res.json().catch(() => null), res.status));
}

/** Subscribe to a run's live milestones over SSE. Returns an unsubscribe.
 * `report` is terminal: the server closes the stream there, so we close the
 * EventSource too — otherwise the browser auto-reconnects and replays the whole
 * run every few seconds forever. Any other disconnect (serve restart, 404 on a
 * forgotten run) lands in `onError` so the UI can stop spinning. */
export function streamRun(runId: string, onEvent: (e: LoopEvent) => void, onError?: () => void): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  let done = false;
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as LoopEvent;
      if (e.kind === "report") {
        done = true;
        es.close();
      }
      onEvent(e);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    es.close();
    if (!done) onError?.();
  };
  return () => es.close();
}
