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

export interface TeamAgent {
  id: string;
  teamId: string;
  adapter: string;
  model: string;
  busHandle: string | null;
  state: string;
  createdAt: string;
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

const get = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);

export const getTeams = (liveOnly = false): Promise<Team[]> => get(`/api/teams${liveOnly ? "?live=1" : ""}`);
export const getTeamTasks = (teamId: string): Promise<Task[]> => get(`/api/teams/${encodeURIComponent(teamId)}/tasks`);
export const getAgents = (): Promise<TeamAgent[]> => get("/api/agents");
export const getRuns = (): Promise<Run[]> => get("/api/runs");

export async function startLoop(input: StartLoopInput): Promise<{ runId: string }> {
  const res = await fetch("/api/loop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<{ runId: string }>;
}

export async function createTeam(input: CreateTeamInput): Promise<Team> {
  const res = await fetch("/api/teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      members: [{ model: input.workerModel, cwd: input.cwd, ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}) }],
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<Team>;
}

export const drainTeam = (teamId: string): Promise<Response> =>
  fetch(`/api/teams/${encodeURIComponent(teamId)}/drain`, { method: "POST" });

// ── Persistent bus agents (the multi-agent path) ───────────────────────────
// Distinct from `TeamAgent` above (the older task-worker shape from /api/agents):
// these are addressable @handle agents that live on the team's bus channel —
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
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
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

/** Read a bus channel's recent history (GET-only proxy; the chat stream). */
export const getChannelHistory = (channelId: string, limit = 60): Promise<{ messages: ChannelMessage[] }> =>
  get(`/api/channels/${encodeURIComponent(channelId)}/history?limit=${limit}`);

/** Answer a loop that's waiting on a proactive question (routes over the bus). */
export async function answerRun(runId: string, answer: { qid?: string; optionId?: string; text?: string }): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(answer),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

/** Subscribe to a run's live milestones over SSE. Returns an unsubscribe. */
export function streamRun(runId: string, onEvent: (e: LoopEvent) => void): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as LoopEvent);
    } catch {
      /* ignore malformed */
    }
  };
  return () => es.close();
}
