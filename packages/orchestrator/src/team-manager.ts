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
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentSpawnSpec, AgentSpec, AgentStatus, LoopBody, MayaDb, TaskRow, TeamRow, TeamTopology } from '@maya-ai/core';
import { HANDLE_RE, RESERVED_LEAD_HANDLE } from '@maya-ai/core';
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
  /**
   * A worker must reach a terminal state within this budget or it is killed
   * and the task fails LOUDLY with its captured stderr — no more silent
   * settle-timeout hangs when a worker wedges (bad cwd, stuck process). The
   * live incident: a cwd Claude Code wouldn't operate in left the task in
   * `working` forever. Default 5 min.
   */
  workerTimeoutMs?: number;
}

interface InFlightWorker {
  agentId: string;
  adapter: ReturnType<AgentRuntime['adapter']>;
}

/** A standing agent on the team channel — spawned interactive (no one-shot
 * prompt), attached to the bus, addressable by its @handle, woken by messages. */
interface PersistentAgent {
  spec: AgentSpec;
  agentId: string; // adapter handle id
  busHandle: string;
  adapter: ReturnType<AgentRuntime['adapter']>;
  state: AgentStatus['state'];
  pid?: number;
}

interface LiveTeam {
  team: TeamRow;
  templates: MemberTemplate[];
  manager: BusClient;
  /** The manager's bus handle — its system announcements must not wake agents. */
  managerHandle: string;
  /** taskId → live worker (one worker per in-flight task). */
  inFlight: Map<string, InFlightWorker>;
  /** @handle → standing agent (the persistent Lead + workers). */
  persistent: Map<string, PersistentAgent>;
  nextTemplate: number;
  draining: boolean;
}

export class TeamManager {
  private readonly live = new Map<string, LiveTeam>();
  private readonly maxAttempts: number;
  private readonly workerTimeoutMs: number;

  constructor(private readonly opts: TeamManagerOptions) {
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.workerTimeoutMs = opts.workerTimeoutMs ?? 300_000;
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

    const lt = await this.bringLive(team, input.members);
    lt.manager.sendMessage({ body: { text: `🧭 team **${input.name}** ready — ${input.members.length} member template(s), topology ${input.topology}` } });
    return team;
  }

  /** Bring a team's live shell up: mint the manager's scoped token, connect its
   * BusClient, join the room, register the LiveTeam. Shared by createTeam +
   * rehydrate (agents are added separately). */
  private async bringLive(team: TeamRow, templates: MemberTemplate[]): Promise<LiveTeam> {
    const res = await fetch(`${this.httpBase()}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.bus.adminToken}` },
      body: JSON.stringify({ label: 'manager', role: 'admin', caps: ['receive', 'send'], scopes: [team.channelId] }),
    });
    if (!res.ok) throw new Error(`manager token mint failed: HTTP ${res.status}`);
    const minted = (await res.json()) as { token: string };
    const manager = new BusClient({ wsBase: this.opts.bus.wsBase, channelId: team.channelId, token: minted.token });
    const joined = new Promise<string>((r) => manager.on('joined', (j: { handle: string }) => r(j.handle)));
    manager.connect();
    const managerHandle = await joined;
    const lt: LiveTeam = {
      team,
      templates,
      manager,
      managerHandle,
      inFlight: new Map<string, InFlightWorker>(),
      persistent: new Map<string, PersistentAgent>(),
      nextTemplate: 0,
      draining: false,
    };
    this.live.set(team.id, lt);
    return lt;
  }

  /**
   * Re-hydrate standing teams after a serve restart: reload every active team
   * from the DB, reconnect its manager, and re-spawn its persisted standing
   * agents — so a restart never silently wipes a live team + its agents again
   * (the bug where the dashboard composer went dead because nothing was "live").
   * Best-effort: a team whose manager won't reconnect is left for a later boot;
   * an agent spec that won't spawn is dropped so it doesn't retry every boot.
   * NOTE: member TEMPLATES aren't persisted, so task-dispatch needs them re-added
   * after a restart — standing agents (what users chat with) are what we restore.
   */
  async rehydrate(): Promise<{ teams: number; agents: number }> {
    let teamsBack = 0;
    let agentsBack = 0;
    for (const team of this.opts.db.teams()) {
      if (team.state !== 'active' || this.live.has(team.id)) continue;
      let lt: LiveTeam;
      try {
        lt = await this.bringLive(team, []);
      } catch {
        continue;
      }
      teamsBack++;
      const specs = this.opts.db.standingAgents(team.id);
      let restored = 0;
      for (const { handle, spec } of specs) {
        try {
          await this.spawnAgent(team.id, spec as AgentSpec);
          restored++;
          agentsBack++;
        } catch {
          this.opts.db.removeStandingAgent(team.id, handle);
        }
      }
      if (specs.length > 0) {
        lt.manager.sendMessage({ body: { text: `♻️ **${team.name}** restored after restart — ${restored}/${specs.length} agent(s) back online` } });
      }
    }
    return { teams: teamsBack, agents: agentsBack };
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
  /**
   * Tear a live team down. `close` (default true) marks it `closed` in the DB
   * and drops its persisted agent specs — a permanent close. On **serve
   * shutdown** pass `close=false`: kill the live processes but leave the team
   * `active` + keep its standing-agent specs, so `rehydrate()` restores it on the
   * next boot instead of the restart silently killing every team.
   */
  async drain(teamId: string, reason: string, close = true): Promise<void> {
    const lt = this.mustLive(teamId);
    if (lt.draining) return;
    lt.draining = true;
    if (close) this.opts.db.setTeamState(teamId, 'draining');
    lt.manager.sendMessage({ body: { text: `🛑 team ${close ? 'draining' : 'pausing for restart'}: ${reason}` } });
    for (const [taskId, worker] of [...lt.inFlight]) {
      await worker.adapter.kill(worker.agentId).catch(() => {});
      lt.inFlight.delete(taskId);
      const task = this.opts.db.task(taskId);
      if (task && task.state !== 'done' && task.state !== 'failed') {
        this.opts.db.transitionTask(taskId, 'failed', { result: `drained: ${reason}` });
      }
    }
    // Tear down the standing agents too — detach revokes each bus token.
    for (const [handle, a] of [...lt.persistent]) {
      lt.persistent.delete(handle);
      if (a.agentId) {
        await this.opts.bridge.detach(a.agentId).catch(() => {});
        await a.adapter.kill(a.agentId).catch(() => {});
      }
    }
    if (close) {
      this.opts.db.setTeamState(teamId, 'closed');
      this.opts.db.removeStandingAgents(teamId); // permanent close → don't re-hydrate
    }
    // close=false (serve shutdown): team stays 'active' + specs kept → rehydrate() restores it.
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

  /** The live TeamRow, or throw — used to run a loop on a standing team. */
  requireTeam(teamId: string): TeamRow {
    const lt = this.live.get(teamId);
    if (!lt) throw new Error(`team ${teamId} is not live — create it through this manager first`);
    return lt.team;
  }

  /** Is this team currently live (created through this manager, not drained)? */
  isLive(teamId: string): boolean {
    return this.live.has(teamId);
  }

  // ── persistent agents (the multi-agent team on the bus) ────────────────

  /**
   * Spawn a STANDING agent into a live team: a real coding agent
   * (claude-code/codex/opencode) started interactive (no one-shot prompt, so it
   * stays alive) and attached to the team channel with a least-capability
   * ['receive','send'] token, addressable by its @handle. This is the seam that
   * 02's MCP `spawn_agent` AND the human "solo agent" both call. The handle is
   * caller-provided and enforced unique per the contract (never auto-suffixed).
   */
  async spawnAgent(teamId: string, spec: AgentSpec): Promise<AgentStatus> {
    const lt = this.mustLive(teamId);
    const { handle } = spec;
    if (!HANDLE_RE.test(handle)) throw new Error(`invalid handle "${handle}" — must be @lowercase-kebab (${HANDLE_RE.source})`);
    const role: 'lead' | 'worker' = spec.role ?? 'worker';
    if (handle === RESERVED_LEAD_HANDLE && role !== 'lead') throw new Error(`${RESERVED_LEAD_HANDLE} is reserved for the team lead`);
    if (role === 'lead' && handle !== RESERVED_LEAD_HANDLE) throw new Error(`the lead's handle must be ${RESERVED_LEAD_HANDLE}`);
    if (lt.persistent.has(handle)) throw new Error(`handle ${handle} already in use on this team — pick another (handles are unique, never auto-suffixed)`);

    const adapter = this.opts.runtime.adapter(spec.type);
    // Reserve the handle up-front so a concurrent spawn of the same name loses.
    lt.persistent.set(handle, { spec, agentId: '', busHandle: '', adapter, state: 'spawning' });
    try {
      // Walkie-talkie I/O (docs/agent-io.md): the agent READS incoming from its
      // inbox file and WRITES outgoing to its outbox file; the bridge relays both.
      // Per-agent files, created here + passed via env + to the bridge on attach.
      const ioDir = join(homedir(), '.maya', 'agents', `${teamId}-${handle.replace(/^@/, '')}`);
      mkdirSync(ioDir, { recursive: true });
      const inboxPath = join(ioDir, 'in.jsonl');
      const outboxPath = join(ioDir, 'out.jsonl');
      writeFileSync(inboxPath, '');
      writeFileSync(outboxPath, '');
      const walkieHint =
        `You are a persistent agent on a shared team channel. INCOMING: new channel messages are appended as JSON lines to the file at ${inboxPath} — read it to see who said what. OUTGOING: to say ANYTHING on the channel, APPEND a line to the file at ${outboxPath} (plain text, or a JSON line {"text":"…","to":"@who"} to direct it) — the system posts it for you. You may append several lines over time (e.g. with sleep between them) and message on your own initiative; you don't have to wait to be asked. Use your Read/Write/Bash tools on those two absolute paths. Keep running.`;
      const systemPrompt = [spec.systemPrompt, walkieHint].filter(Boolean).join('\n\n');
      const spawnSpec: AgentSpawnSpec = {
        adapter: spec.type as AgentSpawnSpec['adapter'],
        model: spec.model as AgentSpawnSpec['model'],
        cwd: spec.cwd,
        env: { MAYA_AGENT_INBOX: inboxPath, MAYA_AGENT_OUTBOX: outboxPath },
        // NO `prompt` → the adapter runs INTERACTIVE: the process stays alive and
        // is driven by bus messages (the bridge feeds @mentions in, posts out).
        permissionMode: 'auto',
        options: {
          ...(spec.allowedTools !== undefined ? { allowedTools: spec.allowedTools } : {}),
          ...(systemPrompt ? { appendSystemPrompt: systemPrompt } : {}),
          ...(spec.cldzProfile !== undefined ? { cldzProfile: spec.cldzProfile } : {}),
          ...(spec.pty ? { pty: true } : {}), // interactive PTY (real Claude TUI, watchable) vs headless
        },
      };
      const agentHandle = await this.opts.runtime.spawn(spawnSpec);
      const { busHandle } = await this.opts.bridge.attach(adapter, agentHandle, { channelId: lt.team.channelId, label: handle, inboxPath, outboxPath });
      const entry: PersistentAgent = { spec, agentId: agentHandle.id, busHandle, adapter, state: 'live' };
      lt.persistent.set(handle, entry);
      // Persist the full spec so a serve restart can re-hydrate this agent
      // instead of silently losing it (INSERT OR REPLACE — safe on re-spawn).
      this.opts.db.addStandingAgent(teamId, handle, spec);
      // Announce WITHOUT the leading @ so the join notice doesn't @mention (and
      // thus wake) the agent that just joined — it'd greet its own arrival.
      // Real pokes still @mention normally. (himansh's pokes come via the manager
      // relay too, so skipping by sender would wrongly mute them — hence this.)
      lt.manager.sendMessage({ body: { text: `➕ **${handle.replace(/^@/, '')}** joined the team (${spec.type} · ${spec.model})` } });
      return this.statusOf(handle, entry);
    } catch (err) {
      lt.persistent.delete(handle); // release the reserved handle on failure
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** All standing agents on a live team (Lead + workers). Empty for unknown/drained. */
  listAgents(teamId: string): AgentStatus[] {
    const lt = this.live.get(teamId);
    if (!lt) return [];
    return [...lt.persistent.entries()].map(([h, a]) => this.statusOf(h, a));
  }

  /** Stop a standing agent: revoke its bus token (via detach) + kill it, free the handle. */
  async stopAgent(teamId: string, handle: string): Promise<void> {
    const lt = this.mustLive(teamId);
    const a = lt.persistent.get(handle);
    if (!a) throw new Error(`no agent ${handle} on this team`);
    lt.persistent.delete(handle);
    this.opts.db.removeStandingAgent(teamId, handle); // stop persisting → won't re-hydrate
    if (a.agentId) {
      await this.opts.bridge.detach(a.agentId).catch(() => {}); // detach revokes the token
      await a.adapter.kill(a.agentId).catch(() => {});
    }
    lt.manager.sendMessage({ body: { text: `➖ **${handle}** left the team` } });
  }

  /** Live adapter + agentId for one standing agent, so callers can stream its
   * output (`adapter.events(agentId)`) or snapshot its logs — the seam the
   * per-agent "watch the terminal" endpoint needs. Undefined if unknown/not live. */
  agentLiveHandle(
    teamId: string,
    handle: string,
  ): { adapter: ReturnType<AgentRuntime['adapter']>; agentId: string } | undefined {
    const a = this.live.get(teamId)?.persistent.get(handle);
    return a?.agentId ? { adapter: a.adapter, agentId: a.agentId } : undefined;
  }

  private statusOf(handle: string, a: PersistentAgent): AgentStatus {
    return {
      handle,
      type: a.spec.type,
      model: a.spec.model,
      role: a.spec.role ?? 'worker',
      cwd: a.spec.cwd,
      state: a.state,
      ...(a.spec.allowedTools !== undefined ? { allowedTools: a.spec.allowedTools } : {}),
    };
  }

  /**
   * Post a message into the team channel on the manager's connection. Dual-use:
   * the lead's MCP `send_to` (directed to an @handle), the human chat composer,
   * and @wake — a directed message wakes the target agent via the bridge.
   */
  postMessage(teamId: string, text: string, to?: string, human?: boolean): void {
    const lt = this.mustLive(teamId);
    lt.manager.sendMessage({ ...(to ? { to } : {}), body: { text, ...(human ? { human: true } : {}) } });
  }

  /**
   * Drain EVERY live team — called on serve shutdown so spawned agents don't
   * orphan across a restart. drain() kills each agent by the child pid the
   * adapter tracks (SIGTERM→SIGKILL), scoped to Maya's own processes — never a
   * grep, so human Claude Code sessions are never touched.
   */
  async drainAll(reason = 'serve shutdown'): Promise<void> {
    // close=false: a shutdown must NOT close teams — leave them active + keep
    // their specs so rehydrate() brings them back on the next boot.
    await Promise.all([...this.live.keys()].map((id) => this.drain(id, reason, false).catch(() => {})));
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
    let busHandle: string;
    try {
      ({ busHandle } = await this.opts.bridge.attach(adapter, handle, {
        channelId: lt.team.channelId,
        label: `worker-${task.id.slice(-4)}`,
      }));
    } catch (err) {
      // Attach failure used to hang the whole run (assign never returned) —
      // kill the orphan and fail the task with a clear reason instead.
      await adapter.kill(handle.id).catch(() => {});
      this.opts.db.transitionTask(task.id, 'failed', { result: `bus attach failed: ${String(err)}`, bumpAttempts: true });
      lt.manager.sendMessage({ body: { text: `❌ ${task.id} could not join the channel: ${String(err).slice(0, 160)}` } });
      this.maybeRetry(lt, task.id);
      return this.opts.db.task(task.id)!;
    }
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
    let lastStderr = '';
    let toolCalls = 0;
    let failed: string | null = null;
    let timedOut = false;

    // Watchdog: a worker that never reaches a terminal state gets killed, so
    // the event stream closes and the terminal handling below runs with a
    // clear reason — instead of the run hanging until settle timeout.
    const watchdog = setTimeout(() => {
      timedOut = true;
      void adapter.kill(agentId).catch(() => {});
    }, this.workerTimeoutMs);
    watchdog.unref?.();

    try {
      for await (const ev of adapter.events(agentId)) {
        if (ev.kind === 'state') {
          this.opts.db.setAgentState(agentId, ev.state);
          if (ev.state === 'running') this.safeTransition(taskId, 'working');
        } else if (ev.kind === 'log' && ev.stream === 'stdout' && ev.line.trim()) {
          // The claude-code adapter surfaces each tool call as a stdout line
          // prefixed "[tool] …". Counting them lets us catch a worker that
          // exits cleanly having only NARRATED success without acting (the
          // small-model "parrot"); keep lastOutput as the final prose line.
          if (ev.line.startsWith('[tool]')) toolCalls++;
          else lastOutput = ev.line;
        } else if (ev.kind === 'log' && ev.stream === 'stderr' && ev.line.trim()) {
          lastStderr = ev.line;
        } else if (ev.kind === 'error') {
          failed = ev.message;
        } else if (ev.kind === 'tokens') {
          if (process.env.MAYA_DEBUG_TOKENS) console.error(`[dbg tokens] task=${taskId} +${ev.input}/${ev.output}`);
          const { exhausted } = this.opts.db.addTeamTokens(lt.team.id, ev.input + ev.output);
          if (exhausted && !lt.draining) {
            clearTimeout(watchdog);
            void this.drain(lt.team.id, 'token budget exhausted');
            return;
          }
        }
      }
    } catch {
      failed = failed ?? 'event stream broke';
    }
    clearTimeout(watchdog);

    lt.inFlight.delete(taskId);
    const final = await adapter.status(agentId).catch(() => null);
    if (timedOut) failed = `worker exceeded ${Math.round(this.workerTimeoutMs / 1000)}s without finishing${lastStderr ? ` (last stderr: ${lastStderr.slice(0, 160)})` : ''}`;
    const cleanExit = final?.state === 'exited' && failed === null;
    if (cleanExit) {
      // A clean exit with ZERO tool calls is the tell-tale "parrot": the worker
      // narrated success (often in Claude Code's own post-tool phrasing) without
      // ever acting. Flag it in the result + done message so it's diagnosable
      // instead of a silent success — the verifier still rules on the goal.
      const noop = toolCalls === 0;
      const result = `${noop ? '[⚠ 0 tool calls — may have narrated without acting] ' : `[${toolCalls} tool call(s)] `}${lastOutput}`.slice(0, 2000);
      this.safeTransition(taskId, 'done', { result });
      lt.manager.sendMessage({
        body: {
          text: `✅ ${taskId} done${noop ? ' (⚠ 0 tool calls)' : ''}`,
          maya: { kind: 'task_done', taskId, summary: result.slice(0, 300) } satisfies LoopBody,
        },
      });
    } else {
      const base = failed ?? `worker ended in state ${final?.state ?? 'unknown'} with no result`;
      const reason = failed === null && lastStderr ? `${base} — last stderr: ${lastStderr.slice(0, 200)}` : base;
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
