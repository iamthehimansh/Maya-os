/**
 * TeamManager integration over a REAL bus with a scripted one-shot worker
 * adapter (no CLIs, no models): dependency scheduling, lifecycle-driven task
 * states, retry-on-failure, budget hard-stop, channel visibility.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentSpawnSpec,
  BusMessageFrame,
  LoopBody,
} from '@maya-ai/core';
import { MayaDb } from '@maya-ai/core';
import { AgentBusBridge, AgentRuntime } from '@maya-ai/agent-runtime';
import { BusClient } from '@maya-ai/bus-client';
import { mintToken, startBusServer, type RunningBusServer } from '@maya-ai/bus';
import { TeamManager } from '../src/team-manager.js';
import { ScriptedWorkers } from './scripted-workers.js';


let running: RunningBusServer | null = null;
const clients: BusClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  if (running) {
    await running.close();
    running = null;
  }
});

async function setup(budget?: number) {
  running = await startBusServer({ dbPath: ':memory:', port: 0 });
  const admin = running.bootstrapAdminToken!;
  const wsBase = `ws://127.0.0.1:${running.port}`;
  const db = new MayaDb(':memory:');
  const runtime = new AgentRuntime({ gatewayBaseUrl: 'http://127.0.0.1:1' }); // gateway unused by scripted workers
  const workers = new ScriptedWorkers();
  runtime.register(workers);
  const bridge = new AgentBusBridge({ wsBase, adminToken: admin.token });
  const tm = new TeamManager({ db, runtime, bridge, bus: { wsBase, adminToken: admin.token } });
  const team = await tm.createTeam({
    name: 'test-team',
    topology: 'round-robin',
    members: [{ adapter: 'scripted', model: 'local/x', cwd: '/tmp' }],
    ...(budget !== undefined ? { tokenBudget: budget } : {}),
  });
  return { db, tm, team, workers, wsBase, adminToken: admin.token };
}

async function watchChannel(wsBase: string, channelId: string, db: RunningBusServer['db']) {
  const { token } = mintToken(db, { label: 'observer', scopes: [channelId] });
  const client = new BusClient({ wsBase, channelId, token }).connect();
  clients.push(client);
  const seen: BusMessageFrame[] = [];
  client.on('message', (m) => seen.push(m));
  await new Promise<void>((r) => client.on('joined', () => r()));
  return seen;
}

describe('TeamManager', () => {
  it('runs a dependent task graph to completion with visible hand-offs', async () => {
    const { db, tm, team, wsBase } = await setup();
    const seen = await watchChannel(wsBase, team.channelId, running!.db);

    const a = tm.addTask(team.id, 'build the thing');
    const b = tm.addTask(team.id, 'test the thing (needs A)', { deps: [a.id] });

    await tm.settle(team.id);

    expect(db.task(a.id)?.state).toBe('done');
    expect(db.task(b.id)?.state).toBe('done');
    expect(db.task(a.id)?.result).toContain('build the thing');

    const kinds = seen.map((m) => (m.body.maya as LoopBody | undefined)?.kind).filter(Boolean);
    expect(kinds.filter((k) => k === 'task_assign').length).toBe(2);
    expect(kinds.filter((k) => k === 'task_done').length).toBe(2);
    // B was never assigned before A finished.
    const assignB = seen.findIndex((m) => (m.body.maya as LoopBody | undefined)?.kind === 'task_assign' && (m.body.maya as { taskId?: string }).taskId === b.id);
    const doneA = seen.findIndex((m) => (m.body.maya as LoopBody | undefined)?.kind === 'task_done' && (m.body.maya as { taskId?: string }).taskId === a.id);
    expect(assignB).toBeGreaterThan(doneA);
  }, 30_000);

  it('retries a failed task and succeeds within the attempt budget', async () => {
    const { db, tm, team } = await setup();
    const t = tm.addTask(team.id, 'flaky FAIL_ONCE job');
    await tm.settle(team.id);
    const final = db.task(t.id)!;
    expect(final.state).toBe('done');
    expect(final.attempts).toBe(1); // one failure, then success
  }, 30_000);

  it('hard-stops the team when the token budget is exhausted', async () => {
    const { db, tm, team, workers } = await setup(500);
    tm.addTask(team.id, 'expensive TOKENS:600 job');
    const later = tm.addTask(team.id, 'never runs');

    await tm.settle(team.id).catch(() => {}); // drain interrupts settle
    // Give the drain a beat to finish.
    await new Promise((r) => setTimeout(r, 300));

    expect(db.team(team.id)?.state).toBe('closed');
    expect(db.task(later.id)?.state).toBe('queued'); // never dispatched
    expect(workers.spawned).toBe(1);
  }, 30_000);
});
