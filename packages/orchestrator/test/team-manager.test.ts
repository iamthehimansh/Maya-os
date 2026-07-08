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

  it('refuses worker models measured as non-tool-calling (Coder-series lesson)', async () => {
    running = await startBusServer({ dbPath: ':memory:', port: 0 });
    const admin = running.bootstrapAdminToken!;
    const wsBase = `ws://127.0.0.1:${running.port}`;
    const db = new MayaDb(':memory:');
    const runtime = new AgentRuntime({ gatewayBaseUrl: 'http://127.0.0.1:1' });
    runtime.register(new ScriptedWorkers());
    const bridge = new AgentBusBridge({ wsBase, adminToken: admin.token });
    const caps: Record<string, { toolCalling?: boolean } | null> = {
      'local/coder': { toolCalling: false },
      'local/instruct': { toolCalling: true },
    };
    const tm = new TeamManager({
      db,
      runtime,
      bridge,
      bus: { wsBase, adminToken: admin.token },
      modelCapabilities: async (m) => caps[m] ?? null,
    });

    await expect(
      tm.createTeam({ name: 'bad', topology: 'round-robin', members: [{ adapter: 'scripted', model: 'local/coder', cwd: '/tmp' }] }),
    ).rejects.toThrow(/cannot tool-call/);

    // Override hatch + measured-true + unknown models all pass.
    const okTeam = await tm.createTeam({
      name: 'ok',
      topology: 'round-robin',
      members: [
        { adapter: 'scripted', model: 'local/instruct', cwd: '/tmp' },
        { adapter: 'scripted', model: 'local/unknown-cloud', cwd: '/tmp' },
        { adapter: 'scripted', model: 'local/coder', cwd: '/tmp', allowNonToolCalling: true },
      ],
    });
    expect(okTeam.id).toBeTruthy();
    await tm.drain(okTeam.id, 'test done');
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

  it('watchdog fails a hung worker loudly with its stderr (no silent settle-timeout)', async () => {
    // Finding #1: a worker that never terminates used to hang the whole run.
    running = await startBusServer({ dbPath: ':memory:', port: 0 });
    const admin = running.bootstrapAdminToken!;
    const wsBase = `ws://127.0.0.1:${running.port}`;
    const db = new MayaDb(':memory:');
    const runtime = new AgentRuntime({ gatewayBaseUrl: 'http://127.0.0.1:1' });
    runtime.register(new ScriptedWorkers());
    const bridge = new AgentBusBridge({ wsBase, adminToken: admin.token });
    const tm = new TeamManager({
      db,
      runtime,
      bridge,
      bus: { wsBase, adminToken: admin.token },
      workerTimeoutMs: 600, // short for the test
      maxAttempts: 1,
    });
    const team = await tm.createTeam({ name: 'wd', topology: 'round-robin', members: [{ adapter: 'scripted', model: 'local/x', cwd: '/tmp' }] });
    const t = tm.addTask(team.id, 'this one HANG STDERR:cwd-not-trusted forever');

    await tm.settle(team.id);
    const final = db.task(t.id)!;
    expect(final.state).toBe('failed');
    expect(final.result).toContain('without finishing');
    expect(final.result).toContain('cwd-not-trusted'); // captured stderr surfaced
  }, 30_000);

  it('spawns, lists, and stops a standing agent — handle-enforced', async () => {
    const { tm, team } = await setup();
    const spec = (h: string, extra: Record<string, unknown> = {}) =>
      ({ handle: h, type: 'scripted', model: 'local/x', cwd: '/tmp', ...extra }) as unknown as import('@maya-ai/core').AgentSpec;

    const status = await tm.spawnAgent(team.id, spec('@backend'));
    expect(status.handle).toBe('@backend');
    expect(status.state).toBe('live');
    expect(status.cwd).toBe('/tmp');
    expect(tm.listAgents(team.id).map((a) => a.handle)).toContain('@backend');

    // duplicate handle → rejected (never auto-suffixed)
    await expect(tm.spawnAgent(team.id, spec('@backend'))).rejects.toThrow(/already in use/);
    // malformed handle → rejected
    await expect(tm.spawnAgent(team.id, spec('nodash'))).rejects.toThrow(/invalid handle/);
    // @lead reserved for the lead role
    await expect(tm.spawnAgent(team.id, spec('@lead', { role: 'worker' }))).rejects.toThrow(/reserved/);

    // stop frees the handle so it can be reused
    await tm.stopAgent(team.id, '@backend');
    expect(tm.listAgents(team.id).map((a) => a.handle)).not.toContain('@backend');
    await expect(tm.stopAgent(team.id, '@backend')).rejects.toThrow(/no agent/);
    const reused = await tm.spawnAgent(team.id, spec('@backend'));
    expect(reused.handle).toBe('@backend');
  }, 30_000);

  it('flags a clean exit with zero tool calls (the small-model "parrot")', async () => {
    // A 3B worker under the full agentic prompt can NARRATE success (in Claude
    // Code's own post-tool phrasing) and exit 0 without ever calling a tool.
    // The verifier still rules on the goal, but the no-op must be diagnosable
    // instead of a silent `done` — this is the observability capture.
    const { db, tm, team } = await setup();
    const parrot = tm.addTask(team.id, 'narrate success without acting'); // no TOOL marker → 0 tool calls
    const actor = tm.addTask(team.id, 'actually write it TOOL'); // TOOL marker → a real tool call
    await tm.settle(team.id);

    const p = db.task(parrot.id)!;
    const a = db.task(actor.id)!;
    expect(p.state).toBe('done');
    expect(p.result).toContain('0 tool calls'); // parrot is flagged
    expect(a.state).toBe('done');
    expect(a.result).toMatch(/1 tool call/); // real actor counted
    expect(a.result).not.toContain('0 tool calls');
  }, 30_000);
});
