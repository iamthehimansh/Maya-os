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
import { ensureMayaTeamSkill } from '@maya-ai/agent-runtime';
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
  lastMessageAt?: string;
}

/** How standing LEAD agents reach Maya's own MCP server (spawn_agent, send_to,
 * …): the per-team config file spawnAgent writes + points `--mcp-config` at. */
export interface McpServeConfig {
  command: string;
  args: string[];
  /** This orchestrator's own HTTP base — known only after listen(). */
  orchestratorUrl: string;
  gatewayUrl?: string;
}

interface LiveTeam {
  team: TeamRow;
  templates: MemberTemplate[];
  manager: BusClient;
  /** Bus token id backing `manager` — revoked on drain so admin tokens don't
   * accumulate across boots. */
  managerTokenId: string;
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
  private mcpServe: McpServeConfig | null = null;

  constructor(private readonly opts: TeamManagerOptions) {
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.workerTimeoutMs = opts.workerTimeoutMs ?? 300_000;
  }

  /** Enable MCP injection for standing LEAD agents (contract: the service
   * calls this after listen(), once its own URL is known — see service.ts). */
  configureMcp(cfg: McpServeConfig): void {
    this.mcpServe = cfg;
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
    // Persist the member templates so rehydrate() restores DISPATCH too — a
    // restored team used to come back chat-only and hang loops to settle-timeout.
    this.opts.db.setTeamTemplates(team.id, input.members);

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
    const minted = (await res.json()) as { id: string; token: string };
    const manager = new BusClient({ wsBase: this.opts.bus.wsBase, channelId: team.channelId, token: minted.token });
    // The bare 'joined' wait used to hang forever on a rejected join (the bus
    // emits 'error' + reconnects; 'joined' never fires) — createTeam's HTTP
    // request and the whole rehydrate loop stalled. Timeout + error path.
    let joinedOk = false;
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bus join timed out for team ${team.id}`)), 10_000);
      timer.unref?.();
      manager.on('joined', () => {
        joinedOk = true;
        clearTimeout(timer);
        resolve();
      });
      manager.on('error', (e) => {
        // Pre-join: fail bringLive loudly. Post-join: a rejected frame (e.g.
        // bad_frame) is otherwise a SILENT no-op send — at least log it.
        if (!joinedOk) {
          clearTimeout(timer);
          reject(new Error(`bus join rejected for team ${team.id}: ${e.code} ${e.message}`));
        } else {
          console.error(`[team-manager] bus error on team ${team.id}: ${e.code} ${e.message}`);
        }
      });
    });
    manager.connect();
    try {
      await joined;
    } catch (err) {
      manager.close();
      throw err;
    }
    const lt: LiveTeam = {
      team,
      templates,
      manager,
      managerTokenId: minted.id,
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
   * an agent spec that won't spawn is KEPT (a transient boot race must not
   * erase the agent forever) — it's marked failed in the roster, logged, and
   * announced on the channel, then retried on the next boot. Member templates
   * are restored from team_templates so task-dispatch works after a restart.
   */
  async rehydrate(): Promise<{ teams: number; agents: number }> {
    let teamsBack = 0;
    let agentsBack = 0;
    for (const team of this.opts.db.teams()) {
      // A crash mid-drain leaves 'draining' forever (rehydrate skipped it, the
      // drain route 404'd — a permanent zombie row). Its processes are gone
      // after a restart anyway, so sweep it to 'closed' on boot.
      if (team.state === 'draining') {
        this.opts.db.setTeamState(team.id, 'closed');
        this.opts.db.removeStandingAgents(team.id);
        continue;
      }
      if (team.state !== 'active' || this.live.has(team.id)) continue;
      let lt: LiveTeam;
      try {
        lt = await this.bringLive(team, this.opts.db.teamTemplates(team.id) as MemberTemplate[]);
      } catch (err) {
        console.error(`[team-manager] rehydrate: team ${team.id} (${team.name}) won't come live: ${String(err instanceof Error ? err.message : err)} — retrying next boot`);
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
        } catch (err) {
          const msg = String(err instanceof Error ? err.message : err);
          console.error(`[team-manager] rehydrate: agent ${handle} on team ${team.id} failed to spawn: ${msg}`);
          // Keep the spec for the next boot; show the failure in the roster
          // (GET /agents) instead of pretending the agent never existed.
          try {
            const s = spec as AgentSpec;
            lt.persistent.set(handle, { spec: s, agentId: '', busHandle: '', adapter: this.opts.runtime.adapter(s.type), state: 'failed' });
          } catch {
            /* unknown adapter — no roster entry, spec still persisted */
          }
          lt.manager.sendMessage({ body: { text: `⚠️ could not restore **${handle.replace(/^@/, '')}** after restart: ${msg.slice(0, 160)} — will retry next boot` } });
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
    // 0 templates + ready work would otherwise spin until settle-timeout (a
    // silent 5-minute hang) — fail loudly instead. Only pre-template-persistence
    // teams restored from an old DB can hit this now.
    if (lt.templates.length === 0 && this.opts.db.readyTasks(teamId).length > 0) {
      throw new Error(`team ${teamId} has no member templates (restored from a pre-template-persistence DB?) — recreate the team`);
    }
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
        // Permanent close fails the work; a restart pause (close=false)
        // RE-QUEUES it so the restored team resumes instead of a shutdown
        // silently killing every in-flight task forever.
        if (close) this.safeTransition(taskId, 'failed', { result: `drained: ${reason}` });
        else this.safeTransition(taskId, 'queued');
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
    // Revoke the manager's admin-scoped bus token — every boot × team minted a
    // fresh one and nothing ever revoked it (live credentials piled up in bus.db).
    await fetch(`${this.httpBase()}/api/tokens/${lt.managerTokenId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.opts.bus.adminToken}` },
    }).catch(() => {});
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

  /** In-flight worker count without the per-team task-list fetch status() does
   * — GET /api/teams maps EVERY historical team, so this must stay O(1). */
  inFlightCount(teamId: string): number {
    return this.live.get(teamId)?.inFlight.size ?? 0;
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
    if (lt.draining) throw new Error(`team ${teamId} is draining — no new agents`);
    const { handle } = spec;
    if (!HANDLE_RE.test(handle)) throw new Error(`invalid handle "${handle}" — must be @lowercase-kebab (${HANDLE_RE.source})`);
    const role: 'lead' | 'worker' = spec.role ?? 'worker';
    if (handle === RESERVED_LEAD_HANDLE && role !== 'lead') throw new Error(`${RESERVED_LEAD_HANDLE} is reserved for the team lead`);
    if (role === 'lead' && handle !== RESERVED_LEAD_HANDLE) throw new Error(`the lead's handle must be ${RESERVED_LEAD_HANDLE}`);
    // A dead agent's handle (stopped/failed — e.g. a crash or a failed
    // rehydrate) is re-claimable; only a live/spawning one blocks the spawn.
    const existing = lt.persistent.get(handle);
    if (existing && existing.state !== 'stopped' && existing.state !== 'failed') {
      throw new Error(`handle ${handle} already in use on this team — pick another (handles are unique, never auto-suffixed)`);
    }

    const adapter = this.opts.runtime.adapter(spec.type);
    // WHICH CONVERSATION does this agent open? A revived agent used to come back
    // as a blank slate — brief gone, teammates gone, its own work gone. So every
    // standing agent owns a stable session id: the FIRST spawn mints one and the
    // agent starts fresh under it; EVERY later spawn (crash-respawn, stop→revive,
    // rehydrate after a serve restart) finds the same id and RESUMES into it.
    //
    // It must be a real UUID — `claude --session-id` rejects anything else.
    //
    // Two places remember it, and both are load-bearing: the persisted spec
    // (which rehydrate replays back to us), and the DB memo — which survives
    // stopAgent deleting the spec row, so a stopped agent can still be revived
    // into its own conversation. Per-agent ids (never `--continue`) are also what
    // keeps two agents sharing one cwd from resuming EACH OTHER's session.
    const knownSessionId = spec.sessionId ?? this.opts.db.agentSession(teamId, handle);
    const sessionId = knownSessionId ?? randomUUID();
    const resumeSession = knownSessionId !== undefined;
    const agentSpec: AgentSpec = { ...spec, sessionId };
    // Reserve the handle up-front so a concurrent spawn of the same name loses.
    lt.persistent.set(handle, { spec: agentSpec, agentId: '', busHandle: '', adapter, state: 'spawning' });
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
      // A standing agent must stay ALIVE between turns, which only a native TUI in
      // a pty does: claude-code and mayac (maya code) both have one. codex/opencode
      // are headless one-shot, so they keep the piped path.
      const isPty = (spec.type === 'claude-code' || spec.type === 'mayac') && spec.pty !== false;
      // Self-driven means the agent runs /maya-team and pumps its OWN inbox. That
      // skill installs as a CLAUDE CODE slash command (~/.claude/commands), which
      // mayac cannot see — it has no slash commands at all, only `.skills/`
      // discovery. So a mayac pty agent is BRIDGE-driven instead: the bridge types
      // directed messages into its TUI, and it replies via the outbox file (the
      // generic walkie hint below spells that contract out).
      const selfDriven = isPty && spec.type === 'claude-code';
      const walkieHint = selfDriven
        ? // Self-driven (himansh's walkie-talkie architecture): the agent runs
          // /maya-team — ITS OWN Monitor on the inbox wakes it per message
          // (untagged included); the bridge never types messages in.
          `You are a persistent agent on a Maya team channel. Run /maya-team NOW to start your loop — it wires your Monitor to $MAYA_AGENT_INBOX (every channel message wakes you) and teaches you to speak via $MAYA_AGENT_OUTBOX. If the command is unavailable: read new JSON lines from ${inboxPath} on a 1s Monitor loop and append replies to ${outboxPath} (plain text or {"text":"…","to":"@who"}). Keep running forever.`
        : `You are a persistent agent on a shared team channel. INCOMING: new channel messages are appended as JSON lines to the file at ${inboxPath} — read it to see who said what. OUTGOING: to say ANYTHING on the channel, APPEND a line to the file at ${outboxPath} (plain text, or a JSON line {"text":"…","to":"@who"} to direct it) — the system posts it for you. You may append several lines over time (e.g. with sleep between them) and message on your own initiative; you don't have to wait to be asked. Use your Read/Write/Bash tools on those two absolute paths. Keep running.`;
      const systemPrompt = [spec.systemPrompt, walkieHint].filter(Boolean).join('\n\n');
      if (selfDriven) ensureMayaTeamSkill(); // idempotent — /maya-team available to the spawned TUI
      // Standing LEAD agents get Maya's own MCP server (spawn_agent/send_to/…)
      // via a per-team --mcp-config file, when the serve enabled it.
      let mcpConfigPath: string | undefined;
      if (role === 'lead' && this.mcpServe) {
        const mcpDir = join(homedir(), '.maya', 'mcp');
        mkdirSync(mcpDir, { recursive: true });
        mcpConfigPath = join(mcpDir, `${teamId}.json`);
        writeFileSync(
          mcpConfigPath,
          JSON.stringify(
            {
              mcpServers: {
                maya: {
                  command: this.mcpServe.command,
                  args: this.mcpServe.args,
                  env: {
                    MAYA_ORCHESTRATOR_URL: this.mcpServe.orchestratorUrl,
                    MAYA_GATEWAY_URL: this.mcpServe.gatewayUrl ?? '',
                    MAYA_TEAM_ID: teamId,
                  },
                },
              },
            },
            null,
            2,
          ),
        );
      }
      // Native-subscription auth (the owner's own `claude login` / `codex login`
      // creds) rides adapter-side via options.auth — the same seam as
      // cldzProfile. Carried on the AgentSpec as an optional field the adapters
      // read; threaded here so a standing agent can run on the owner's own
      // subscription instead of the local gateway.
      const auth = spec.auth;
      const spawnSpec: AgentSpawnSpec = {
        adapter: spec.type as AgentSpawnSpec['adapter'],
        model: spec.model as AgentSpawnSpec['model'],
        cwd: spec.cwd,
        env: { MAYA_AGENT_INBOX: inboxPath, MAYA_AGENT_OUTBOX: outboxPath, MAYA_AGENT_HANDLE: handle },
        // First spawn → the adapter passes `--session-id <id>` (start THIS
        // conversation); revive → `--resume <id>` (reopen it). Adapters with no
        // session flags (codex/opencode) ignore both.
        sessionId,
        ...(resumeSession ? { resumeSession: true } : {}),
        // NO `prompt` → the adapter runs INTERACTIVE: the process stays alive and
        // is driven by bus messages (the bridge feeds @mentions in, posts out).
        permissionMode: 'auto',
        options: {
          ...(spec.allowedTools !== undefined ? { allowedTools: spec.allowedTools } : {}),
          ...(systemPrompt ? { appendSystemPrompt: systemPrompt } : {}),
          ...(spec.cldzProfile !== undefined ? { cldzProfile: spec.cldzProfile } : {}),
          ...(auth !== undefined ? { auth } : {}),
          // PTY is the DEFAULT for standing agents on the types that HAVE a TUI
          // (himansh: the real Claude/mayac TUI, watchable live) — opt OUT with
          // pty:false, never opt in.
          ...(isPty ? { pty: true } : {}),
          ...(mcpConfigPath !== undefined ? { mcpConfig: mcpConfigPath } : {}),
        },
      };
      const agentHandle = await this.opts.runtime.spawn(spawnSpec);
      // Re-check after the await: a drain that raced this spawn already took
      // its snapshot — kill the fresh process instead of leaking it (and
      // re-persisting a spec on a permanently closed team below).
      if (lt.draining || !this.live.has(teamId)) {
        await adapter.kill(agentHandle.id).catch(() => {});
        throw new Error(`team ${teamId} drained while spawning ${handle}`);
      }
      const { busHandle } = await this.opts.bridge.attach(adapter, agentHandle, {
        channelId: lt.team.channelId,
        label: handle,
        inboxPath,
        outboxPath,
        // Self-driven agents run /maya-team: their own Monitor reads the inbox
        // (tagged AND untagged) — the bridge must not also type messages in.
        // A mayac pty agent is NOT self-driven, so the bridge types for it.
        ...(selfDriven ? { selfDriven: true } : {}),
      });
      if (lt.draining || !this.live.has(teamId)) {
        await this.opts.bridge.detach(agentHandle.id).catch(() => {});
        await adapter.kill(agentHandle.id).catch(() => {});
        throw new Error(`team ${teamId} drained while spawning ${handle}`);
      }
      // Bootstrap the self-driven loop: the ONE line the bridge ever types into
      // a claude-code pty agent — /maya-team starts its Monitor + outbox
      // discipline. A mayac agent gets its inbox/outbox contract from the persona
      // preamble the adapter types as turn 0 (mayac has no --append-system-prompt),
      // so there is nothing to bootstrap here.
      if (selfDriven) void adapter.send(agentHandle.id, '/maya-team').catch(() => {});
      const entry: PersistentAgent = {
        spec: agentSpec,
        agentId: agentHandle.id,
        busHandle,
        adapter,
        state: 'live',
        ...(agentHandle.pid !== undefined ? { pid: agentHandle.pid } : {}),
      };
      lt.persistent.set(handle, entry);
      // Keep the roster truthful: track the agent's lifecycle so a crash shows
      // as stopped/failed (not an eternal 'live'), and count its tokens.
      void this.watchPersistent(lt, handle, entry);
      // Persist the full spec so a serve restart can re-hydrate this agent
      // instead of silently losing it (INSERT OR REPLACE — safe on re-spawn).
      // The spec now carries sessionId, so rehydrate hands it straight back to
      // us and the restored agent resumes rather than starting over.
      this.opts.db.addStandingAgent(teamId, handle, agentSpec);
      // Memo the id only once the spawn actually WORKED. A spawn that died before
      // the CLI ever wrote a session file must not leave a memo behind — the next
      // attempt would `--resume` a conversation that never existed.
      this.opts.db.rememberAgentSession(teamId, handle, sessionId);
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
    // Strip the leading @ like spawnAgent's join notice — an announcement must
    // never @mention (and wake) an agent, e.g. a quickly-reused handle.
    lt.manager.sendMessage({ body: { text: `➖ **${handle.replace(/^@/, '')}** left the team` } });
  }

  /**
   * Monitor a standing agent's lifecycle (task workers get watch(); standing
   * agents used to get NOTHING — a crashed agent showed 'live' forever while
   * messages to it silently vanished). Updates the roster state, records
   * activity, feeds token events into the team budget (standing agents' usage
   * used to be invisible to tokensUsed/tokenBudget), and announces an
   * unexpected death on the channel. EventLog.iterate supports concurrent
   * iterators, so this never starves the bridge or the SSE output endpoint.
   */
  private async watchPersistent(lt: LiveTeam, handle: string, entry: PersistentAgent): Promise<void> {
    // Bail if the entry was replaced (stopAgent freed the handle + a re-spawn).
    const current = (): boolean => lt.persistent.get(handle) === entry;
    try {
      for await (const ev of entry.adapter.events(entry.agentId)) {
        if (!current()) return;
        if (ev.kind === 'state') {
          entry.state =
            ev.state === 'spawning' ? 'spawning'
            : ev.state === 'exited' || ev.state === 'killed' ? 'stopped'
            : ev.state === 'failed' ? 'failed'
            : 'live';
        } else if (ev.kind === 'say') {
          entry.lastMessageAt = ev.at;
        } else if (ev.kind === 'tokens') {
          const { exhausted } = this.opts.db.addTeamTokens(lt.team.id, ev.input + ev.output);
          if (exhausted && !lt.draining) {
            void this.drain(lt.team.id, 'token budget exhausted');
            return;
          }
        }
      }
    } catch {
      /* event stream broke — treat as a death below */
    }
    if (!current() || lt.draining) return; // stopped deliberately (stopAgent/drain)
    const final = await entry.adapter.status(entry.agentId).catch(() => null);
    entry.state = final?.state === 'exited' ? 'stopped' : 'failed';
    lt.manager.sendMessage({
      body: { text: `⚠️ agent **${handle.replace(/^@/, '')}** ${entry.state === 'stopped' ? 'exited' : 'died'}${final?.exitCode !== undefined ? ` (code ${final.exitCode})` : ''} — re-spawn it or restart the serve to restore` },
    });
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
      ...(a.pid !== undefined ? { pid: a.pid } : {}),
      ...(a.lastMessageAt !== undefined ? { lastMessageAt: a.lastMessageAt } : {}),
    };
  }

  /**
   * Post a message into the team channel on the manager's connection. Dual-use:
   * the lead's MCP `send_to` (directed to an @handle), the human chat composer,
   * and @wake — a directed message wakes the target agent via the bridge.
   */
  postMessage(teamId: string, text: string, to?: string, human?: boolean, attachments?: Array<{ id: string; filename: string }>): void {
    const lt = this.mustLive(teamId);
    lt.manager.sendMessage({
      ...(to ? { to } : {}),
      body: { text, ...(human ? { human: true } : {}), ...(attachments && attachments.length > 0 ? { attachments } : {}) },
    });
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
