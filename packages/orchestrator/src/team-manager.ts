/**
 * TeamManager — Phase 6 core.
 *
 * A team = member TEMPLATES (adapter + model + cwd) + a bus room + a task
 * board (core's MayaDb). Dispatch spawns a fresh ONE-SHOT worker per task
 * from a template (scoped tools + turn caps — the hallucination-loop lesson),
 * bridges it onto the team channel, and drives the task through its states
 * from the worker's lifecycle:
 *
 *   queued → assigned (spawn) → accepted (spawn ok) → working (first
 *   workstatus) → done (clean exit; result = worker's final output)
 *                → failed (crash/non-zero) → re-queued while attempts remain
 *
 * The manager also joins each team room as `manager` and posts loop-protocol
 * `task_assign` frames so every hand-off is visible on the channel; budgets
 * are enforced from the adapters' token events (hard stop → drain).
 * Conversational workers and lead judgment arrive with Phase 7 — this layer
 * stays deterministic.
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSpawnSpec, LoopBody, MayaDb, TaskRow, TeamRow, TeamTopology } from '@maya-ai/core';
import type { AgentRuntime, AgentBusBridge } from '@maya-ai/agent-runtime';
import { BusClient } from '@maya-ai/bus-client';

export interface MemberTemplate {
  adapter: string;
  model: string;
  cwd: string;
  /** Worker scoping applied to every task spawn from this template. */
  allowedTools?: string[];
  maxTurns?: number;
  /**
   * Escape hatch: accept a model whose measured `toolCalling` capability is
   * false (completion-style specialists can't drive agentic workers — the
   * Coder-series lesson). Off by default.
   */
  allowNonToolCalling?: boolean;
}

export interface CreateTeamInput {
  name: string;
  topology: TeamTopology;
  members: MemberTemplate[];
  tokenBudget?: number;
}

export interface TeamManagerOptions {
  db: MayaDb;
  runtime: AgentRuntime;
  bridge: AgentBusBridge;
  bus: { wsBase: string; adminToken: string; httpBase?: string };
  /** Max attempts per task before it stays failed. Default 2. */
  maxAttempts?: number;
  /**
   * Capability lookup for worker-model gating; defaults to the gateway
   * catalog when `gatewayBaseUrl` is set (tests inject their own). Returning
   * null = unknown model/capability → fail-open with a warning; a measured
   * `toolCalling:false` fails team creation unless the template opts out.
   */
  modelCapabilities?: (model: string) => Promise<{ toolCalling?: boolean } | null>;
  gatewayBaseUrl?: string;
}

interface InFlightWorker {
  agentId: string;
  adapter: ReturnType<AgentRuntime['adapter']>;
}

interface LiveTeam {
  team: TeamRow;
  templates: MemberTemplate[];
  manager: BusClient;
  /** taskId → live worker (one worker per in-flight task). */
  inFlight: Map<string, InFlightWorker>;
  nextTemplate: number;
  draining: boolean;
}

export class TeamManager {
  private readonly live = new Map<string, LiveTeam>();
  private readonly maxAttempts: number;

  constructor(private readonly opts: TeamManagerOptions) {
    this.maxAttempts = opts.maxAttempts ?? 2;
  }

  private httpBase(): string {
    return (this.opts.bus.httpBase ?? this.opts.bus.wsBase.replace(/^ws/, 'http')).replace(/\/$/, '');
  }

  // ── team lifecycle ────────────────────────────────────────────────────

  async createTeam(input: CreateTeamInput): Promise<TeamRow> {
    if (input.members.length === 0) throw new Error('a team needs at least one member template');
    await this.gateWorkerModels(input.members);
    const team = this.opts.db.createTeam({
      name: input.name,
      topology: input.topology,
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    });

    // The manager joins the room with its own scoped token (admin-minted).
    const res = await fetch(`${this.httpBase()}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.bus.adminToken}` },
      body: JSON.stringify({ label: 'manager', role: 'admin', caps: ['receive', 'send'], scopes: [team.channelId] }),
    });
    if (!res.ok) throw new Error(`manager token mint failed: HTTP ${res.status}`);
    const minted = (await res.json()) as { token: string };
    const manager = new BusClient({ wsBase: this.opts.bus.wsBase, channelId: team.channelId, token: minted.token });
    const joined = new Promise<void>((r) => manager.on('joined', () => r()));
    manager.connect();
    await joined;

    this.live.set(team.id, {
      team,
      templates: input.members,
      manager,
      inFlight: new Map<string, InFlightWorker>(),
      nextTemplate: 0,
      draining: false,
    });
    manager.sendMessage({ body: { text: `🧭 team **${input.name}** ready — ${input.members.length} member template(s), topology ${input.topology}` } });
    return team;
  }

  addTask(teamId: string, spec: string, opts?: { deps?: string[]; scope?: string[] }): TaskRow {
    this.mustLive(teamId);
    return this.opts.db.createTask({
      teamId,
      spec,
      ...(opts?.deps !== undefined ? { deps: opts.deps } : {}),
      ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
    });
  }

  /**
   * Assign every ready task to a worker (round-robin over templates),
   * respecting a concurrency cap. Returns the tasks dispatched this call.
   */
  async dispatch(teamId: string, opts?: { maxConcurrent?: number }): Promise<TaskRow[]> {
    const lt = this.mustLive(teamId);
    if (lt.draining) return [];
    const cap = opts?.maxConcurrent ?? lt.templates.length;
    const dispatched: TaskRow[] = [];
    for (const task of this.opts.db.readyTasks(teamId)) {
      if (lt.inFlight.size >= cap) break;
      dispatched.push(await this.assign(lt, task));
    }
    return dispatched;
  }

  /** Wait until the team has no in-flight workers and no ready tasks. */
  async settle(teamId: string, timeoutMs = 300_000): Promise<void> {
    const lt = this.mustLive(teamId);
    const start = Date.now();
    for (;;) {
      await this.dispatch(teamId);
      const idle = lt.inFlight.size === 0 && this.opts.db.readyTasks(teamId).length === 0;
      if (idle) return;
      if (Date.now() - start > timeoutMs) throw new Error('settle timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Stop accepting work; kill in-flight workers; mark the team closed. */
  async drain(teamId: string, reason: string): Promise<void> {
    const lt = this.mustLive(teamId);
    if (lt.draining) return;
    lt.draining = true;
    this.opts.db.setTeamState(teamId, 'draining');
    lt.manager.sendMessage({ body: { text: `🛑 team draining: ${reason}` } });
    for (const [taskId, worker] of [...lt.inFlight]) {
      await worker.adapter.kill(worker.agentId).catch(() => {});
      lt.inFlight.delete(taskId);
      const task = this.opts.db.task(taskId);
      if (task && task.state !== 'done' && task.state !== 'failed') {
        this.opts.db.transitionTask(taskId, 'failed', { result: `drained: ${reason}` });
      }
    }
    this.opts.db.setTeamState(teamId, 'closed');
    lt.manager.close();
    this.live.delete(teamId);
  }

  status(teamId: string): { team: TeamRow; tasks: TaskRow[]; inFlight: number } {
    const team = this.opts.db.team(teamId);
    if (!team) throw new Error(`unknown team ${teamId}`);
    return { team, tasks: this.opts.db.tasks(teamId), inFlight: this.live.get(teamId)?.inFlight.size ?? 0 };
  }

  /** status() for dashboards: null for unknown/not-live teams instead of throwing. */
  statusSafe(teamId: string): { team: TeamRow; tasks: TaskRow[]; inFlight: number } | null {
    try {
      return this.status(teamId);
    } catch {
      return null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private mustLive(teamId: string): LiveTeam {
    const lt = this.live.get(teamId);
    if (!lt) throw new Error(`team ${teamId} is not live (create it through this manager)`);
    return lt;
  }

  /**
   * Worker models must tool-call (measured capability from the catalog):
   * a measured false fails fast with a pointer to the fix; unknown models
   * (no lookup configured / not in catalog / capability unmeasured) pass
   * open — cloud models and custom gateways stay usable.
   */
  private async gateWorkerModels(members: MemberTemplate[]): Promise<void> {
    const lookup =
      this.opts.modelCapabilities ??
      (this.opts.gatewayBaseUrl !== undefined ? gatewayCapabilityLookup(this.opts.gatewayBaseUrl) : null);
    if (!lookup) return;
    for (const m of members) {
      if (m.allowNonToolCalling === true) continue;
      const caps = await lookup(m.model).catch(() => null);
      if (caps?.toolCalling === false) {
        throw new Error(
          `worker model ${m.model} cannot tool-call (measured) — agentic workers need a tool-calling model (e.g. an Instruct-series); set allowNonToolCalling:true to override`,
        );
      }
    }
  }

  private async assign(lt: LiveTeam, task: TaskRow): Promise<TaskRow> {
    const template = lt.templates[lt.nextTemplate % lt.templates.length]!;
    lt.nextTemplate += 1;

    this.opts.db.transitionTask(task.id, 'assigned');

    const spec: AgentSpawnSpec = {
      adapter: template.adapter as AgentSpawnSpec['adapter'],
      model: template.model as AgentSpawnSpec['model'],
      cwd: template.cwd,
      prompt: task.spec,
      permissionMode: 'auto',
      options: {
        ...(template.allowedTools !== undefined ? { allowedTools: template.allowedTools } : {}),
        ...(template.maxTurns !== undefined ? { maxTurns: template.maxTurns } : {}),
      },
    };

    let handle;
    try {
      handle = await this.opts.runtime.spawn(spec);
    } catch (err) {
      this.opts.db.transitionTask(task.id, 'failed', { result: `spawn failed: ${String(err)}`, bumpAttempts: true });
      this.maybeRetry(lt, task.id);
      return this.opts.db.task(task.id)!;
    }

    const adapter = this.opts.runtime.adapter(template.adapter);
    const { busHandle } = await this.opts.bridge.attach(adapter, handle, {
      channelId: lt.team.channelId,
      label: `worker-${task.id.slice(-4)}`,
    });
    this.opts.db.addAgent({
      id: handle.id,
      teamId: lt.team.id,
      adapter: template.adapter,
      model: template.model,
      busHandle,
      state: handle.state,
    });
    this.opts.db.transitionTask(task.id, 'accepted', { assignee: handle.id });
    lt.inFlight.set(task.id, { agentId: handle.id, adapter });

    // Visible hand-off on the channel.
    const assignBody: LoopBody = {
      kind: 'task_assign',
      taskId: task.id,
      spec: task.spec,
      ...(task.scope.length > 0 ? { scope: task.scope } : {}),
    };
    lt.manager.sendMessage({ body: { text: `📋 ${task.id} → ${busHandle}: ${task.spec.slice(0, 120)}`, maya: assignBody } });

    // Watch the worker's lifecycle; token events feed the budget.
    void this.watch(lt, task.id, handle.id, adapter);
    return this.opts.db.task(task.id)!;
  }

  private async watch(
    lt: LiveTeam,
    taskId: string,
    agentId: string,
    adapter: ReturnType<AgentRuntime['adapter']>,
  ): Promise<void> {
    let lastOutput = '';
    let failed: string | null = null;
    try {
      for await (const ev of adapter.events(agentId)) {
        if (ev.kind === 'state') {
          this.opts.db.setAgentState(agentId, ev.state);
          if (ev.state === 'running') this.safeTransition(taskId, 'working');
        } else if (ev.kind === 'log' && ev.stream === 'stdout' && ev.line.trim()) {
          lastOutput = ev.line;
        } else if (ev.kind === 'error') {
          failed = ev.message;
        } else if (ev.kind === 'tokens') {
          const { exhausted } = this.opts.db.addTeamTokens(lt.team.id, ev.input + ev.output);
          if (exhausted && !lt.draining) {
            void this.drain(lt.team.id, 'token budget exhausted');
            return;
          }
        }
      }
    } catch {
      failed = failed ?? 'event stream broke';
    }

    lt.inFlight.delete(taskId);
    const final = await adapter.status(agentId).catch(() => null);
    const cleanExit = final?.state === 'exited' && failed === null;
    if (cleanExit) {
      this.safeTransition(taskId, 'done', { result: lastOutput.slice(0, 2000) });
      lt.manager.sendMessage({
        body: {
          text: `✅ ${taskId} done`,
          maya: { kind: 'task_done', taskId, summary: lastOutput.slice(0, 300) } satisfies LoopBody,
        },
      });
    } else {
      const reason = failed ?? `worker ended in state ${final?.state ?? 'unknown'}`;
      this.safeTransition(taskId, 'failed', { result: reason.slice(0, 500), bumpAttempts: true });
      lt.manager.sendMessage({
        body: {
          text: `❌ ${taskId} failed: ${reason.slice(0, 160)}`,
          maya: { kind: 'task_failed', taskId, error: reason.slice(0, 300), retryable: true } satisfies LoopBody,
        },
      });
      this.maybeRetry(lt, taskId);
    }
  }

  /** Re-queue a failed task while attempts remain (crash-safe retry). */
  private maybeRetry(lt: LiveTeam, taskId: string): void {
    const task = this.opts.db.task(taskId);
    if (!task || task.state !== 'failed' || lt.draining) return;
    if (task.attempts < this.maxAttempts) {
      this.opts.db.transitionTask(taskId, 'queued');
      lt.manager.sendMessage({ body: { text: `🔁 ${taskId} re-queued (attempt ${task.attempts + 1}/${this.maxAttempts})` } });
    }
  }

  /** Transition that tolerates already-terminal races (drain vs watch). */
  private safeTransition(taskId: string, to: Parameters<MayaDb['transitionTask']>[1], opts?: Parameters<MayaDb['transitionTask']>[2]): void {
    try {
      this.opts.db.transitionTask(taskId, to, opts);
    } catch {
      /* terminal race — the earlier transition wins */
    }
  }
}

export const newRunId = (): string => 'run_' + randomUUID().replaceAll('-', '').slice(0, 10);

/** Default capability lookup: the gateway catalog's measured `capabilities`. */
function gatewayCapabilityLookup(gatewayBaseUrl: string) {
  const base = gatewayBaseUrl.replace(/\/$/, '');
  return async (model: string): Promise<{ toolCalling?: boolean } | null> => {
    const res = await fetch(`${base}/api/models`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok) return null;
    const catalog = (await res.json()) as Array<{ id: string; capabilities?: { toolCalling?: boolean } }>;
    return catalog.find((m) => m.id === model)?.capabilities ?? null;
  };
}
