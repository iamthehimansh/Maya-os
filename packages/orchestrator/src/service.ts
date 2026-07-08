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
import { MayaDb } from '@maya-ai/core';
import { AgentBusBridge, AgentRuntime } from '@maya-ai/agent-runtime';
import { LlmClient } from './llm.js';
import { makeGoalCheck, makePlanner, makeVerifier } from './judgment.js';
import { LoopLead, type LoopEvent, type LoopReport } from './loop-lead.js';
import { TeamManager } from './team-manager.js';

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

  app.get('/api/teams', (c) =>
    c.json(
      db.teams().map((t) => ({
        ...t,
        inFlight: teams.statusSafe(t.id)?.inFlight ?? 0,
      })),
    ),
  );
  app.get('/api/teams/:id/tasks', (c) => c.json(db.tasks(c.req.param('id'))));
  app.get('/api/teams/:id/agents', (c) => c.json(db.agents(c.req.param('id'))));
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
        const send = (e: LoopEvent): void => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          if (e.kind === 'report') {
            subs.delete(listener);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };
        const listener = (e: LoopEvent): void => send(e);
        for (const e of record.events) send(e); // replay timeline
        if (record.state === 'done') {
          try {
            controller.close();
          } catch {
            /* closed */
          }
          return;
        }
        const subs = runSubs.get(record.runId) ?? new Set();
        runSubs.set(record.runId, subs);
        subs.add(listener);
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
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
    } | null;
    if (!body?.goal || !body.leadModel || !body.workerModel || !body.cwd) {
      return c.json({ error: 'goal, leadModel, workerModel, cwd required' }, 400);
    }
    const runId = 'run_' + Date.now().toString(36);
    const record: RunRecord = { runId, goal: body.goal, state: 'running', startedAt: new Date().toISOString(), events: [] };
    runs.set(runId, record);
    const onEvent = (e: LoopEvent): void => {
      record.events.push(e);
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
      team: {
        topology: 'manager-tree',
        members: [
          {
            adapter: body.workerAdapter ?? 'claude-code',
            model: body.workerModel,
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
      .run(body.goal, { name: runId })
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
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
    },
  };
}
