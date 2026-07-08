/**
 * Thin HTTP client the MCP tools proxy through — one place that talks to Maya's
 * orchestrator (teams/agents) and gateway (models). Kept separate from the MCP
 * wiring so it's unit-testable against a mock base URL.
 */

export interface AgentSpecInput {
  handle: string;
  type: "claude-code" | "codex" | "opencode";
  model: string;
  cwd: string;
  role?: "lead" | "worker";
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface MayaClientConfig {
  orchestratorUrl: string; // e.g. http://127.0.0.1:4400
  gatewayUrl: string; // e.g. http://127.0.0.1:4100
  teamId: string; // the lead's team — injected when the lead is spawned
  fetchImpl?: typeof fetch; // injectable for tests
}

export class MayaClient {
  private readonly f: typeof fetch;
  constructor(private readonly cfg: MayaClientConfig) {
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async json(url: string, init?: RequestInit): Promise<unknown> {
    const res = await this.f(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body;
  }

  spawnAgent(agent: AgentSpecInput): Promise<unknown> {
    return this.json(`${this.cfg.orchestratorUrl}/api/teams/${encodeURIComponent(this.cfg.teamId)}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent }),
    });
  }

  stopAgent(handle: string): Promise<unknown> {
    return this.json(
      `${this.cfg.orchestratorUrl}/api/teams/${encodeURIComponent(this.cfg.teamId)}/agents/${encodeURIComponent(handle)}`,
      { method: "DELETE" },
    );
  }

  listAgents(): Promise<unknown> {
    return this.json(`${this.cfg.orchestratorUrl}/api/teams/${encodeURIComponent(this.cfg.teamId)}/agents`);
  }

  sendTo(handle: string, text: string): Promise<unknown> {
    return this.json(`${this.cfg.orchestratorUrl}/api/teams/${encodeURIComponent(this.cfg.teamId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: handle, text }),
    });
  }

  async listModels(): Promise<Array<{ id: string; toolCalling?: boolean }>> {
    const body = (await this.json(`${this.cfg.gatewayUrl}/api/models`)) as Array<{ id: string; toolCalling?: boolean }>;
    return Array.isArray(body) ? body : [];
  }
}
