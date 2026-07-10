/**
 * Orchestrator service — the agent plane's HTTP surface (default :4400).
 *
 * Owns the live AgentRuntime + TeamManager + LoopLead instances and exposes
 * what the dashboard's Agents/Teams tabs (and later the CLI) consume:
 *
 *   GET  /api/orchestrator/health          → { ok, busPort }
 *   GET  /api/teams                        → TeamRow[] (+ live, inFlight)
 *   DELETE /api/teams/:id                  → archive a non-live team (409 if live)
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

import { randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { MayaDb, type AgentSpec, type LoopBody } from '@maya-ai/core';
import { AgentBusBridge, AgentRuntime, listCldzProfiles } from '@maya-ai/agent-runtime';
import { BusClient } from '@maya-ai/bus-client';
import { LlmClient } from './llm.js';
import { makeGoalCheck, makePlanner, makeVerifier } from './judgment.js';
import { LoopLead, type LoopEvent, type LoopReport } from './loop-lead.js';
import { TeamManager, newRunId, type CreateTeamInput } from './team-manager.js';

export interface OrchestratorServiceOptions {
  /** SQLite path for the platform db; ':memory:' for tests. */
  dbPath: string;
  gatewayBaseUrl: string;
  bus: { wsBase: string; adminToken: string; httpBase?: string };
  port?: number; // 0 = ephemeral
  host?: string;
  /** Bearer required for POST routes; omit = open on localhost. */
  adminToken?: string;
  /** How to launch Maya's own MCP stdio server (e.g. the CLI's hidden
   * `mcp-serve` subcommand). When set, standing LEAD agents get a per-team
   * --mcp-config wired to it (spawn_agent/send_to/… from inside the agent). */
  mcpServe?: { command: string; args: string[] };
}

/** LoopReport with a nullable team: a run that throws before creating its
 * team has none — `null` is honest where `null as never` used to crash readers. */
export type RunReport = Omit<LoopReport, 'team'> & { team: LoopReport['team'] | null };

export interface RunRecord {
  runId: string;
  goal: string;
  state: 'running' | 'done';
  startedAt: string;
  report?: RunReport;
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

  // busPort is part of the documented health contract (header comment above).
  let busPort: number | undefined;
  try {
    busPort = Number(new URL(opts.bus.wsBase).port) || undefined;
  } catch {
    /* non-URL wsBase (tests) — health reports ok only */
  }
  app.get('/api/orchestrator/health', (c) => c.json({ ok: true, ...(busPort !== undefined ? { busPort } : {}) }));

  // `?live=1` → only teams currently live in the manager (standing teams not
  // yet drained) — what `maya team list` wants. Default returns ALL teams,
  // including closed per-run ones, for the dashboard's history view. `live`
  // is the manager's truth per row — the dashboard must derive its LIVE badge
  // + composer enablement from it, never from state !== 'closed' (a team whose
  // rehydrate failed is DB-'active' but dead — the zombie-composer bug).
  app.get('/api/teams', (c) => {
    const liveOnly = c.req.query('live') === '1';
    const rows = db.teams().filter((t) => !liveOnly || teams.isLive(t.id));
    return c.json(rows.map((t) => ({ ...t, live: teams.isLive(t.id), inFlight: teams.inFlightCount(t.id) })));
  });
  app.get('/api/teams/:id/tasks', (c) => c.json(db.tasks(c.req.param('id'))));
  // cldz auth profiles available to spawn agents on (names + types ONLY, never
  // secrets) — powers the web "run this agent on <profile>" picker.
  app.get('/api/cldz/profiles', (c) => c.json(listCldzProfiles()));

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

  // RAW terminal input — the dashboard's interactive 🖥️ types the human's
  // keystrokes straight into the agent's pty (bytes, no Enter appended). Only
  // pty-capable adapters support it; message-level talk stays on /messages.
  app.post('/api/teams/:id/agents/:handle/input', async (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live` }, 400);
    const handle = decodeURIComponent(c.req.param('handle'));
    const live = teams.agentLiveHandle(id, handle);
    if (!live) return c.json({ error: `no live agent ${handle} on team ${id}` }, 404);
    const body = (await c.req.json().catch(() => null)) as { data?: string } | null;
    if (typeof body?.data !== 'string' || body.data.length === 0) return c.json({ error: 'data (string) required' }, 400);
    if (body.data.length > 4096) return c.json({ error: 'data too large (4KiB max per write)' }, 400);
    try {
      if (!live.adapter.writeRaw) return c.json({ error: 'this agent has no interactive terminal (not a pty agent)' }, 400);
      live.adapter.writeRaw(live.agentId, body.data);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
    }
  });

  // Live per-agent output stream (SSE) — powers the dashboard "watch the agent's
  // terminal" panel (himansh's right-rail live view). Streams the agent's
  // structured events (log lines, say, error, state, tokens) as they arrive via
  // the adapter's event iterator, which replays a backlog then tails live and
  // returns when the agent exits. Frame: `data: <AgentEvent JSON>\n\n`.
  app.get('/api/teams/:id/agents/:handle/output', (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live` }, 400);
    const handle = decodeURIComponent(c.req.param('handle')); // @name may arrive %40-encoded
    const live = teams.agentLiveHandle(id, handle);
    if (!live) return c.json({ error: `no live agent ${handle} on team ${id}` }, 404);
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const close = (): void => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        void (async () => {
          try {
            // events() replays buffered events then blocks for live ones; the
            // enqueue throws once the client disconnects, which ends the loop.
            for await (const ev of live.adapter.events(live.agentId)) {
              if (closed) break;
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            }
          } catch {
            /* client gone or agent iterator errored */
          }
          close();
        })();
      },
      cancel() {
        closed = true; // client disconnected
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
  });

  // ── Chat attachments ────────────────────────────────────────────────────
  // Files the owner drops into the chat composer. Stored flat under
  // ~/.maya/attachments/<random>-<sanitized-name>; the stored basename IS the
  // attachment id, so agents can Read the file directly from that dir.
  const ATTACH_DIR = join(homedir(), '.maya', 'attachments');
  const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
  /** Strip any path parts + shell-hostile chars; never empty, bounded length. */
  const sanitizeFilename = (name: string): string => {
    const base = name.replace(/^.*[\\/]/, '').replace(/[^\w.\- ()]+/g, '_').replace(/\.{2,}/g, '.').trim();
    return (base.replace(/^\.+/, '') || 'file').slice(0, 120);
  };
  const contentTypeFor = (name: string): string => {
    const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
    const types: Record<string, string> = {
      txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
      json: 'application/json', html: 'text/html; charset=utf-8', pdf: 'application/pdf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      zip: 'application/zip', gz: 'application/gzip', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    };
    return types[ext] ?? 'application/octet-stream';
  };
  /** Serve one stored attachment (shared by the bare + team-scoped routes). */
  const serveAttachment = (id: string): Response => {
    const jsonErr = (error: string, status: number): Response =>
      new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
    // Path-traversal guard: the id is a stored basename — never a path.
    if (id.includes('/') || id.includes('\\') || id.includes('..')) return jsonErr('bad attachment id', 400);
    const path = join(ATTACH_DIR, id);
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) return jsonErr('attachment not found', 404);
      size = st.size;
    } catch {
      return jsonErr('attachment not found', 404);
    }
    const filename = id.replace(/^[0-9a-f]+-/, '') || id;
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'content-type': contentTypeFor(filename),
        'content-length': String(size),
        'content-disposition': `attachment; filename="${filename.replace(/["\r\n]/g, '')}"`,
      },
    });
  };

  // Upload: multipart (field "file") or JSON {filename, dataBase64} → {id, filename}.
  app.post('/api/teams/:id/attachments', async (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live` }, 400);
    let filename: string;
    let bytes: Buffer;
    if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.['file'];
      // Duck-typed File check — works whether the runtime exposes the File global or not.
      if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
        return c.json({ error: 'multipart field "file" required' }, 400);
      }
      const f = file as File;
      if (f.size > ATTACH_MAX_BYTES) return c.json({ error: 'file too large (25MB max)' }, 413);
      filename = f.name || 'file';
      bytes = Buffer.from(await f.arrayBuffer());
    } else {
      const body = (await c.req.json().catch(() => null)) as { filename?: string; dataBase64?: string } | null;
      if (!body?.filename || typeof body.dataBase64 !== 'string') {
        return c.json({ error: 'filename + dataBase64 required (or multipart field "file")' }, 400);
      }
      filename = body.filename;
      bytes = Buffer.from(body.dataBase64, 'base64');
    }
    if (bytes.length > ATTACH_MAX_BYTES) return c.json({ error: 'file too large (25MB max)' }, 413);
    const safe = sanitizeFilename(filename);
    const storedId = `${randomBytes(6).toString('hex')}-${safe}`;
    try {
      mkdirSync(ATTACH_DIR, { recursive: true });
      writeFileSync(join(ATTACH_DIR, storedId), bytes);
    } catch (err) {
      return c.json({ error: `store failed: ${String(err instanceof Error ? err.message : err)}` }, 500);
    }
    return c.json({ id: storedId, filename: safe }, 201);
  });

  // Download. The team-scoped alias exists because both dashboard proxies (vite
  // dev + apps/cli/src/dashboard.ts) route by prefix and only /api/teams/* comes
  // here — bare /api/attachments/* would fall through to the gateway until the
  // proxies add that prefix.
  app.get('/api/attachments/:id/raw', (c) => serveAttachment(c.req.param('id')));
  app.get('/api/teams/:id/attachments/:aid/raw', (c) => serveAttachment(c.req.param('aid')));

  // Post a message into the team channel. Powers 02's MCP `send_to` (directed to
  // an @handle), the human chat composer, and @wake (a directed message wakes
  // the addressed agent via the bridge).
  app.post('/api/teams/:id/messages', async (c) => {
    const id = c.req.param('id');
    if (!teams.isLive(id)) return c.json({ error: `team ${id} is not live` }, 400);
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      to?: string;
      human?: boolean;
      attachments?: Array<{ id?: unknown; filename?: unknown }>;
    } | null;
    if (!body?.text) return c.json({ error: 'text required' }, 400);
    // Optional attachment metadata rides along into the bus body (≤16, ids are
    // stored basenames — reject anything path-shaped).
    let attachments: Array<{ id: string; filename: string }> | undefined;
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments) || body.attachments.length > 16) {
        return c.json({ error: 'attachments must be an array of ≤16 {id, filename}' }, 400);
      }
      attachments = [];
      for (const a of body.attachments) {
        if (typeof a?.id !== 'string' || typeof a.filename !== 'string' || a.id.includes('/') || a.id.includes('\\') || a.id.includes('..')) {
          return c.json({ error: 'each attachment needs a plain string id (no paths) + filename' }, 400);
        }
        attachments.push({ id: a.id, filename: a.filename });
      }
    }
    try {
      teams.postMessage(id, body.text, body.to, body.human === true, attachments);
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
      // Decorate like GET /api/teams so the client's Team type (inFlight,
      // live required) is honest on the create path too.
      return c.json({ ...team, live: true, inFlight: 0 }, 201);
    } catch (err) {
      return c.json({ error: String(err).slice(0, 300) }, 400);
    }
  });

  app.post('/api/teams/:id/drain', async (c) => {
    const id = c.req.param('id');
    if (teams.isLive(id)) {
      await teams.drain(id, 'drained via API');
      return c.json({ ok: true });
    }
    // Not live but still open in the DB (failed rehydrate, crash mid-drain):
    // force-close so a zombie team is always closeable via the API. Idempotent
    // on already-closed teams.
    const team = db.team(id);
    if (!team) return c.json({ error: 'unknown team' }, 404);
    if (team.state !== 'closed') {
      db.setTeamState(id, 'closed');
      db.removeStandingAgents(id);
    }
    return c.json({ ok: true });
  });

  // Archive: hard-delete a closed/dead team + its tasks, worker records, and
  // standing-agent specs. 409 while live — drain first.
  app.delete('/api/teams/:id', (c) => {
    const id = c.req.param('id');
    if (teams.isLive(id)) return c.json({ error: 'team is live — drain it first' }, 409);
    if (!db.team(id)) return c.json({ error: 'unknown team' }, 404);
    db.deleteTeam(id);
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
      const { id: tokenId, token } = (await res.json()) as { id: string; token: string };
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
      // Revoke the per-answer admin token — every answered question used to
      // leave a live admin credential in bus.db forever.
      await fetch(`${httpBase}/api/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${opts.bus.adminToken}` },
      }).catch(() => {});
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
    // Collision-safe (two Date.now()-ms runs used to overwrite each other in
    // `runs`) — and the SINGLE source: LoopLead mints its own internal id, so
    // milestones/reports are rewritten to THIS id below or SSE consumers would
    // match on a foreign runId.
    const runId = newRunId();
    const record: RunRecord = { runId, goal: body.goal, state: 'running', startedAt: new Date().toISOString(), events: [] };
    runs.set(runId, record);
    const onEvent = (ev: LoopEvent): void => {
      const e: LoopEvent = ev.kind === 'started' ? { ...ev, runId } : ev;
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
        record.report = { ...report, runId }; // rewrite the lead's internal id
      })
      .catch((err) => {
        record.state = 'done';
        const summary = `service error: ${String(err).slice(0, 300)}`;
        record.report = { runId, goal: body.goal ?? '', team: null, outcome: 'failed', tasks: [], questionsAsked: 0, summary };
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

  // MCP injection for standing LEAD agents — configured now (the orchestrator's
  // own URL needs the bound port), BEFORE rehydrate re-spawns any leads.
  if (opts.mcpServe) {
    teams.configureMcp({
      command: opts.mcpServe.command,
      args: opts.mcpServe.args,
      orchestratorUrl: `http://${opts.host ?? '127.0.0.1'}:${port}`,
      gatewayUrl: opts.gatewayBaseUrl,
    });
  }

  // Re-hydrate standing teams in the background (non-blocking): a restart must
  // not silently wipe live teams + their agents (the dead-composer bug). The
  // serve already accepts requests; teams come back live + agents re-spawn
  // shortly after boot. Best-effort — a failure logs, never crashes the serve.
  void teams
    .rehydrate()
    .then((r) => {
      if (r.teams > 0) console.log(`[orchestrator] rehydrated ${r.teams} team(s), ${r.agents} agent(s)`);
    })
    .catch((err) => console.error('[orchestrator] rehydrate failed:', err instanceof Error ? err.message : err));

  return {
    port,
    db,
    async close() {
      // Reap spawned agents before exiting so a restart doesn't orphan them
      // (kills each by its tracked child pid — never a grep of `claude`).
      await teams.drainAll('serve shutdown').catch(() => {});
      // Open SSE streams (run followers, agent /output viewers) hold the server
      // alive past close() — sever them so shutdown is instant, not an 8s hang.
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
    },
  };
}
