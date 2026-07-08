/**
 * Orchestrator service: HTTP surface over real components — start a loop run
 * via POST /api/loop with scripted workers + a stub planner model? No — the
 * service wires the REAL LLM planner, so instead we exercise the read routes
 * against a seeded db and validate the POST contract + auth gate. (Full loop
 * runs through the service are covered by the live script; the LoopLead
 * internals have their own integration tests.)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startBusServer, type RunningBusServer } from '@maya-ai/bus';
import { startOrchestratorService, type RunningOrchestrator } from '../src/service.js';

let bus: RunningBusServer | null = null;
let svc: RunningOrchestrator | null = null;

afterEach(async () => {
  if (svc) {
    await svc.close();
    svc = null;
  }
  if (bus) {
    await bus.close();
    bus = null;
  }
});

async function setup(adminToken?: string) {
  bus = await startBusServer({ dbPath: ':memory:', port: 0 });
  svc = await startOrchestratorService({
    dbPath: ':memory:',
    gatewayBaseUrl: 'http://127.0.0.1:1',
    bus: { wsBase: `ws://127.0.0.1:${bus.port}`, adminToken: bus.bootstrapAdminToken!.token },
    port: 0,
    ...(adminToken !== undefined ? { adminToken } : {}),
  });
  return `http://127.0.0.1:${svc.port}`;
}

describe('orchestrator service', () => {
  it('serves health, teams, tasks, agents from the db', async () => {
    const base = await setup();
    expect((await fetch(`${base}/api/orchestrator/health`)).ok).toBe(true);

    const team = svc!.db.createTeam({ name: 'ui-team', topology: 'manager-tree' });
    svc!.db.createTask({ teamId: team.id, spec: 'do something' });
    svc!.db.addAgent({ id: 'ag_x', teamId: team.id, adapter: 'claude-code', model: 'local/q', busHandle: 'w1', state: 'running' });

    const teams = (await (await fetch(`${base}/api/teams`)).json()) as Array<{ id: string; inFlight: number }>;
    expect(teams.map((t) => t.id)).toContain(team.id);

    const tasks = (await (await fetch(`${base}/api/teams/${team.id}/tasks`)).json()) as unknown[];
    expect(tasks).toHaveLength(1);

    const agents = (await (await fetch(`${base}/api/teams/${team.id}/agents`)).json()) as Array<{ id: string }>;
    expect(agents[0]?.id).toBe('ag_x');
  });

  it('validates the loop POST contract and registers the run', async () => {
    const base = await setup();
    const bad = await fetch(`${base}/api/loop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(400);

    const res = await fetch(`${base}/api/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', leadModel: 'local/x', workerModel: 'local/x', cwd: '/tmp' }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };

    // The run will fail fast (gateway is a dead port) but must be REGISTERED
    // and settle into state done with a failure report — never vanish or hang.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const runs = (await (await fetch(`${base}/api/runs`)).json()) as Array<{ runId: string; state: string }>;
      const run = runs.find((r) => r.runId === runId);
      expect(run).toBeTruthy();
      if (run!.state === 'done') break;
      if (Date.now() > deadline) throw new Error('run never settled');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 20_000);

  it('streams run progress over SSE and closes on the terminal report', async () => {
    const base = await setup();
    const res = await fetch(`${base}/api/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', leadModel: 'local/x', workerModel: 'local/x', cwd: '/tmp' }),
    });
    const { runId } = (await res.json()) as { runId: string };

    // Read the SSE stream to completion (the run fails fast on the dead
    // gateway, so a 'report' event arrives and closes the stream).
    const sse = await fetch(`${base}/api/runs/${runId}/events`);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const text = await sse.text(); // resolves when the stream closes
    const events = text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as { kind: string });
    expect(events[0]?.kind).toBe('started');
    expect(events.some((e) => e.kind === 'report')).toBe(true);
  }, 20_000);

  it('returns 404 SSE for an unknown run', async () => {
    const base = await setup();
    const res = await fetch(`${base}/api/runs/nope/events`);
    expect(res.status).toBe(404);
  });

  it('creates a standing team, lists it, and accepts loops targeting it', async () => {
    const base = await setup();
    const bad = await fetch(`${base}/api/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(400);

    const created = await fetch(`${base}/api/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'standing', members: [{ model: 'local/x', cwd: '/tmp' }] }),
    });
    expect(created.status).toBe(201);
    const team = (await created.json()) as { id: string };

    const list = (await (await fetch(`${base}/api/teams`)).json()) as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toContain(team.id);
    // ?live=1 surfaces only standing (live) teams — what `maya team list` uses.
    const liveList = (await (await fetch(`${base}/api/teams?live=1`)).json()) as Array<{ id: string; state: string }>;
    expect(liveList.map((t) => t.id)).toContain(team.id);
    expect(liveList.every((t) => t.state !== 'closed')).toBe(true);

    // A loop targeting the standing team is accepted (worker comes from it)
    // and settles (fails fast on the dead gateway) WITHOUT hanging.
    const loop = await fetch(`${base}/api/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', leadModel: 'local/x', cwd: '/tmp', teamId: team.id }),
    });
    expect(loop.status).toBe(202);
    const { runId } = (await loop.json()) as { runId: string };
    const deadline = Date.now() + 12_000;
    for (;;) {
      const list = (await (await fetch(`${base}/api/runs`)).json()) as Array<{ runId: string; state: string }>;
      if (list.find((r) => r.runId === runId)?.state === 'done') break;
      if (Date.now() > deadline) throw new Error('standing-team run never settled');
      await new Promise((r) => setTimeout(r, 200));
    }

    // Unknown team is rejected; the standing team is still live and drains.
    const badLoop = await fetch(`${base}/api/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', leadModel: 'local/x', cwd: '/tmp', teamId: 'team_nope' }),
    });
    expect(badLoop.status).toBe(400);
    const drained = await fetch(`${base}/api/teams/${team.id}/drain`, { method: 'POST' });
    expect(drained.status).toBe(200);
  }, 20_000);

  it('gates mutating routes behind the admin bearer when configured', async () => {
    const base = await setup('secret-admin');
    const unauthed = await fetch(`${base}/api/loop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthed.status).toBe(401);
    // Reads stay open on localhost.
    expect((await fetch(`${base}/api/teams`)).ok).toBe(true);
  });
});
