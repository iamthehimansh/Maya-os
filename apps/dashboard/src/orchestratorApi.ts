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
