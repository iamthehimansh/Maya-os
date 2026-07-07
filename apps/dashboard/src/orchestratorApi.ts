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

const get = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);

export const getTeams = (): Promise<Team[]> => get("/api/teams");
export const getTeamTasks = (teamId: string): Promise<Task[]> => get(`/api/teams/${encodeURIComponent(teamId)}/tasks`);
export const getAgents = (): Promise<TeamAgent[]> => get("/api/agents");
export const getRuns = (): Promise<Run[]> => get("/api/runs");
