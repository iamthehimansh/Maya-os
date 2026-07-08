/**
 * Orchestrator service — the agent plane's HTTP surface (default :4400).
 *
 * Owns the live AgentRuntime + TeamManager + LoopLead instances and exposes
 * what the dashboard's Agents/Teams tabs (and later the CLI) consume:
 *
 *   GET  /api/orchestrator/health          → { ok, busPort }
 *   GET  /api/teams                        → TeamRow[] (+ live inFlight)
 *   GET  /api/teams/:id/tasks              → TaskRow[]
 *   GET  /api/teams/:id/agents             → TeamAgentRow[]
 *   GET  /api/runs                         → loop runs (live + finished)
 *   POST /api/loop  {goal, leadModel, workerAdapter?, workerModel, cwd,
 *                    allowedTools?, maxTurns?, tokenBudget?}
 *        → { runId } (runs async; poll /api/runs)
 *
 * Localhost-bound. Mutating routes require the admin bearer when one is
 * configured (same pattern as the gateway's control API).
 */

import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { MayaDb, type AgentSpec, type LoopBody } from '@maya-ai/core';
import { AgentBusBridge, AgentRuntime } from '@maya-ai/agent-runtime';
import { BusClient } from '@maya-ai/bus-client';
import { LlmClient } from './llm.js';
import { makeGoalCheck, makePlanner, makeVerifier } from './judgment.js';
import { LoopLead, type LoopEvent, type LoopReport } from './loop-lead.js';
import { TeamManager, type CreateTeamInput } from './team-manager.js';

export interface OrchestratorServiceOptions {
  /** SQLite path for the platform db; ':memory:' for tests. */
  dbPath: string;
  gatewayBaseUrl: string;
  bus: { wsBase: string; adminToken: string; httpBase?: string };
  port?: number; // 0 = ephemeral
  host?: string;
  /** Bearer required for POST routes; omit = open on localhost. */
  adminToken?: string;
}

export interface RunRecord {
  runId: string;
  goal: string;
  state: 'running' | 'done';
  startedAt: string;
  report?: LoopReport;
  /** The team channel this run speaks on — set from the `started` event, used
   * to route an owner's answer back to a loop waiting on a question. */
  channelId?: string;
  /** Buffered live events, so a late SSE subscriber gets the full timeline. */
  events: LoopEvent[];
}

export interface RunningOrchestrator {
  port: number;
  db: MayaDb;
  close(): Promise<void>;
}

export async function startOrchestratorService(opts: OrchestratorServiceOptions): Promise<RunningOrchestrator> {
  const db = new MayaDb(opts.dbPath);
  const runtime = new AgentRuntime({ gatewayBaseUrl: opts.gatewayBaseUrl });
  const bridge = new AgentBusBridge({
    wsBase: opts.bus.wsBase,
    adminToken: opts.bus.adminToken,
    ...(opts.bus.httpBase !== undefined ? { httpBase: opts.bus.httpBase } : {}),
  });
  const teams = new TeamManager({ db, runtime, bridge, bus: opts.bus });
  const runs = new Map<string, RunRecord>();
  /** Live SSE subscribers per run — fed by each run's onEvent. */
  const runSubs = new Map<string, Set<(e: LoopEvent) => void>>();

  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && opts.adminToken !== undefined) {
      if (c.req.header('authorization') !== `Bearer ${opts.adminToken}`) {
        return c.json({ error: 'admin token required' }, 401);
      }
    }
    await next();
  });

  app.get('/api/orchestrator/health', (c) => c.json({ ok: true }));

  // `?live=1` → only teams currently live in the manager (standing teams not
  // yet drained) — what `maya team list` wants. Default returns ALL teams,
  // including closed per-run ones, for the dashboard's history view.
  app.get('/api/teams', (c) => {
    const liveOnly = c.req.query('live') === '1';
    const rows = db.teams().filter((t) => !liveOnly || teams.isLive(t.id));
    return c.json(rows.map((t) => ({ ...t, inFlight: teams.statusSafe(t.id)?.inFlight ?? 0 })));
  });
  app.get('/api/teams/:id/tasks', (c) => c.json(db.tasks(c.req.param('id'))));
  // Standing agents on a team (the persistent Lead + workers). This is the
  // contract 02's MCP `list_agents`/`spawn_agent`/`stop_agent` call.
  app.get('/api/teams/:id/agents', (c) => c.json(teams.listAgents(c.req.param('id'))));
  // Historical task-worker records (per-task, transient) stay available for the
  // Teams page's run history.
  app.get('/api/teams/:id/workers', (c) => c.json(db.agents(c.req.param('id'))));

  app.post('/api/teams/:id/agents', async (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live — create it first` }, 400);
    const raw = (await c.req.json().catch(() => null)) as { agent?: AgentSpec } | AgentSpec | null;
    const agent = (raw && typeof raw === 'object' && 'agent' in raw ? raw.agent : raw) as AgentSpec | undefined;
    if (!agent?.handle || !agent.type || !agent.model || !agent.cwd) {
      return c.json({ error: 'agent { handle, type, model, cwd } required' }, 400);
    }
    try {
      return c.json(await teams.spawnAgent(id, agent), 201);
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
    }
  });

  app.delete('/api/teams/:id/agents/:handle', async (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live` }, 400);
    const handle = decodeURIComponent(c.req.param('handle')); // @name may arrive %40-encoded
    try {
      await teams.stopAgent(id, handle);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 404);
    }
  });

  // Post a message into the team channel. Powers 02's MCP `send_to` (directed to
  // an @handle), the human chat composer, and @wake (a directed message wakes
  // the addressed agent via the bridge).
  app.post('/api/teams/:id/messages', async (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live` }, 400);
    const body = (await c.req.json().catch(() => null)) as { text?: string; to?: string } | null;
    if (!body?.text) return c.json({ error: 'text required' }, 400);
    try {
      teams.postMessage(id, body.text, body.to);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
    }
  });

  // Standing teams: create once (kept LIVE — joins its bus room), then run
  // many loops on it via POST /api/loop {teamId}. `maya team create/list`.
  app.post('/api/teams', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      name?: string;
      topology?: string;
      members?: Array<{ adapter?: string; model?: string; cwd?: string; allowedTools?: string[]; maxTurns?: number }>;
      tokenBudget?: number;
    } | null;
    if (!b?.name || !Array.isArray(b.members) || b.members.length === 0) {
      return c.json({ error: 'name + members[] (each with model + cwd) required' }, 400);
    }
    for (const m of b.members) if (!m.model || !m.cwd) return c.json({ error: 'each member needs model + cwd' }, 400);
    try {
      const team = await teams.createTeam({
        name: b.name,
        topology: (b.topology as CreateTeamInput['topology']) ?? 'manager-tree',
        members: b.members.map((m) => ({
          adapter: m.adapter ?? 'claude-code',
          model: m.model!,
          cwd: m.cwd!,
          ...(m.allowedTools !== undefined ? { allowedTools: m.allowedTools } : {}),
          ...(m.maxTurns !== undefined ? { maxTurns: m.maxTurns } : {}),
        })),
        ...(b.tokenBudget !== undefined ? { tokenBudget: b.tokenBudget } : {}),
      });
      return c.json(team, 201);
    } catch (err) {
      return c.json({ error: String(err).slice(0, 300) }, 400);
    }
  });

  app.post('/api/teams/:id/drain', async (c) => {
    if (!teams.isLive(c.req.param('id'))) return c.json({ error: 'unknown or already-drained team' }, 404);
    await teams.drain(c.req.param('id'), 'drained via API');
    return c.json({ ok: true });
  });
  app.get('/api/agents', (c) => c.json(db.agentsAll()));
  app.get('/api/runs', (c) =>
    c.json([...runs.values()].map(({ events: _events, ...r }) => r).sort((a, b) => b.startedAt.localeCompare(a.startedAt))),
  );

  // Live run progress (SSE): replays buffered events, then streams new ones,
  // and closes when the run reports. The CLI + dashboard consume this for
  // real-time progress instead of polling.
  app.get('/api/runs/:id/events', (c) => {
    const record = runs.get(c.req.param('id'));
    if (!record) return c.json({ error: 'unknown run' }, 404);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        // Register the subscriber set BEFORE replaying: replaying a completed
        // run calls send() on its terminal `report`, which unsubscribes from
        // `subs`. If `subs` were declared after the replay loop it'd be in the
        // temporal dead zone during replay, throwing and 500-ing the whole
        // stream — that was the bug where streaming a finished run errored.
        const subs = runSubs.get(record.runId) ?? new Set<(e: LoopEvent) => void>();
        runSubs.set(record.runId, subs);
        let closed = false;
        const send = (e: LoopEvent): void => {
          if (closed) return; // never enqueue past a terminal report
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          if (e.kind === 'report') {
            subs.delete(listener);
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };
        const listener = (e: LoopEvent): void => send(e);
        for (const e of record.events) send(e); // replay timeline
        if (closed) return; // replay already reached a terminal report
        if (record.state === 'done') {
          try {
            controller.close();
          } catch {
            /* closed */
          }
          return;
        }
        subs.add(listener);
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
  });

  // Route an owner's answer to a loop waiting on a question. The loop's ask()
  // listens on the team channel for an `answer` frame with the matching qid;
  // we post one there via a short-lived admin bus client. This is what makes
  // the chat's tap-able questions two-way.
  app.post('/api/runs/:id/answer', async (c) => {
    const record = runs.get(c.req.param('id'));
    if (!record) return c.json({ error: 'unknown run' }, 404);
    const body = (await c.req.json().catch(() => null)) as { qid?: string; optionId?: string; text?: string } | null;
    if (!body?.qid || (body.optionId === undefined && !body.text)) {
      return c.json({ error: 'qid + (optionId or text) required' }, 400);
    }
    if (!record.channelId) return c.json({ error: 'run has no channel yet' }, 409);
    try {
      const httpBase = opts.bus.wsBase.replace(/^ws/, 'http').replace(/\/$/, '');
      const res = await fetch(`${httpBase}/api/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.bus.adminToken}` },
        // MUST include 'receive': the bus requires it to JOIN a channel (server.ts),
        // and we can't post the answer without first joining. 'send' alone → join
        // is rejected → the client never emits 'joined' → this used to time out.
        body: JSON.stringify({ label: 'owner-answer', role: 'admin', caps: ['receive', 'send'], scopes: [record.channelId] }),
      });
      if (!res.ok) return c.json({ error: `token mint failed: HTTP ${res.status}` }, 502);
      const { token } = (await res.json()) as { token: string };
      const client = new BusClient({ wsBase: opts.bus.wsBase, channelId: record.channelId, token });
      const joined = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('bus join timed out')), 5000);
        client.on('joined', () => {
          clearTimeout(t);
          resolve();
        });
      });
      client.connect();
      await joined;
      const answer: LoopBody = {
        kind: 'answer',
        qid: body.qid,
        ...(body.optionId !== undefined ? { optionId: body.optionId } : {}),
        ...(body.text ? { text: body.text } : {}),
      };
      client.sendMessage({ body: { text: body.text ?? `answer: option ${body.optionId}`, maya: answer } });
      await new Promise((r) => setTimeout(r, 150)); // let the frame flush before closing
      client.close();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `answer failed: ${String(err).slice(0, 200)}` }, 502);
    }
  });

  app.post('/api/loop', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      goal?: string;
      leadModel?: string;
      workerAdapter?: string;
      workerModel?: string;
      cwd?: string;
      allowedTools?: string[];
      maxTurns?: number;
      tokenBudget?: number;
      /** Run on a pre-created standing team instead of a fresh per-run team. */
      teamId?: string;
    } | null;
    // Two shapes: a fresh per-run team (needs workerModel), or a run on an
    // existing standing team (needs teamId; worker comes from the team). Both
    // need a cwd — the workspace the goal is verified against.
    if (!body?.goal || !body.leadModel || !body.cwd) {
      return c.json({ error: 'goal, leadModel, cwd required' }, 400);
    }
    if (body.teamId) {
      if (!teams.isLive(body.teamId)) return c.json({ error: `team ${body.teamId} is not live — create it first` }, 400);
    } else if (!body.workerModel) {
      return c.json({ error: 'workerModel required (or pass teamId to run on a standing team)' }, 400);
    }
    const runId = 'run_' + Date.now().toString(36);
    const record: RunRecord = { runId, goal: body.goal, state: 'running', startedAt: new Date().toISOString(), events: [] };
    runs.set(runId, record);
    const onEvent = (e: LoopEvent): void => {
      record.events.push(e);
      if (e.kind === 'started') record.channelId = e.channelId; // remember where to route answers
      for (const sub of runSubs.get(runId) ?? []) {
        try {
          sub(e);
        } catch {
          /* a dead subscriber must not break the run */
        }
      }
    };
    const llm = new LlmClient({ gatewayBaseUrl: opts.gatewayBaseUrl, model: body.leadModel });
    const lead = new LoopLead({
      db,
      teams,
      onEvent,
      // Fresh-team template (ignored when running on a standing team).
      team: {
        topology: 'manager-tree',
        members: [
          {
            adapter: body.workerAdapter ?? 'claude-code',
            model: body.workerModel ?? 'local/unused',
            cwd: body.cwd,
            ...(body.allowedTools !== undefined ? { allowedTools: body.allowedTools } : {}),
            ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
          },
        ],
        ...(body.tokenBudget !== undefined ? { tokenBudget: body.tokenBudget } : {}),
      },
      planner: makePlanner(llm),
      verifier: makeVerifier(llm, { workspaceDir: body.cwd }),
      goalCheck: makeGoalCheck(body.cwd),
      bus: opts.bus,
    });
    void lead
      .run(body.goal, { name: runId, ...(body.teamId !== undefined ? { existingTeamId: body.teamId } : {}) })
      .then((report) => {
        record.state = 'done';
        record.report = report;
      })
      .catch((err) => {
        record.state = 'done';
        const summary = `service error: ${String(err).slice(0, 300)}`;
        record.report = { runId, goal: body.goal ?? '', team: null as never, outcome: 'failed', tasks: [], questionsAsked: 0, summary };
        // The run threw before finish()'s report event — synthesize one so
        // SSE subscribers get a terminal event and the stream closes.
        if (!record.events.some((e) => e.kind === 'report')) {
          onEvent({ kind: 'report', outcome: 'failed', summary, tokensUsed: 0, at: new Date().toISOString() });
        }
      })
      .finally(() => runSubs.delete(runId));
    return c.json({ runId }, 202);
  });

  const server: Server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(opts.port ?? 4400, opts.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    db,
    async close() {
      // Reap spawned agents before exiting so a restart doesn't orphan them
      // (kills each by its tracked child pid — never a grep of `claude`).
      await teams.drainAll('serve shutdown').catch(() => {});
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
    },
  };
}
