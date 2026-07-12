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
  AgentSpec,
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

/** A standing-agent spec on the scripted adapter — same cwd for every agent, which
 * is the point: a team shares one directory. */
const agentSpec = (handle: string, extra: Record<string, unknown> = {}): AgentSpec =>
  ({ handle, type: 'scripted', model: 'local/x', cwd: '/tmp', ...extra }) as unknown as AgentSpec;

/** What the orchestrator ACTUALLY passed down for this agent's latest spawn. The
 * handle rides in env (MAYA_AGENT_HANDLE), so specs can be attributed per agent. */
const lastSpawnOf = (workers: ScriptedWorkers, handle: string): AgentSpawnSpec => {
  const s = workers.specs.filter((x) => x.env?.MAYA_AGENT_HANDLE === handle).at(-1);
  if (!s) throw new Error(`no spawn recorded for ${handle}`);
  return s;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // ── revive resumes the SAME conversation ─────────────────────────────────
  // A revived agent used to come back as a blank slate — brief gone, teammates
  // gone, its own work gone. Every standing agent now owns a stable session id:
  // the first spawn STARTS that conversation, every later spawn RESUMES it.

  it('mints a session id on first spawn and RESUMES it when the agent is revived', async () => {
    const { db, tm, team, workers } = await setup();

    await tm.spawnAgent(team.id, agentSpec('@backend'));
    const first = workers.specs.at(-1)!;
    // A real UUID, not a "sess_x" — `claude --session-id` rejects anything else.
    expect(first.sessionId).toMatch(UUID_RE);
    expect(first.resumeSession).toBeFalsy(); // first spawn → --session-id <id>

    // Remembered in BOTH places, and they must agree: the spec (what rehydrate
    // replays back) and the memo (what outlives the spec row).
    const persisted = db.standingAgents(team.id).find((a) => a.handle === '@backend')!.spec as AgentSpec;
    expect(persisted.sessionId).toBe(first.sessionId);
    expect(db.agentSession(team.id, '@backend')).toBe(first.sessionId);

    // Stop → revive. stopAgent DELETES the standing_agents row, so the id can
    // only come from the memo — this is the case the memo exists for, and it is
    // the literal promise: stop an agent, revive it, same conversation.
    await tm.stopAgent(team.id, '@backend');
    expect(db.standingAgents(team.id).find((a) => a.handle === '@backend')).toBeUndefined();

    await tm.spawnAgent(team.id, agentSpec('@backend'));
    const revived = workers.specs.at(-1)!;
    expect(revived.sessionId).toBe(first.sessionId); // the SAME conversation
    expect(revived.resumeSession).toBe(true); // revive → --resume <id>
  }, 30_000);

  it('never lets two agents sharing one cwd resume each OTHER (why not --continue)', async () => {
    // `--continue` resumes the most recent conversation in the DIRECTORY, and a
    // team shares one cwd — so it would cross-wire teammates. Per-agent ids are
    // the whole defence; this test is the one that fails if someone "simplifies"
    // back to --continue.
    const { tm, team, workers } = await setup();

    await tm.spawnAgent(team.id, agentSpec('@backend')); // cwd /tmp
    await tm.spawnAgent(team.id, agentSpec('@frontend')); // cwd /tmp — same!
    const backend = lastSpawnOf(workers, '@backend');
    const frontend = lastSpawnOf(workers, '@frontend');

    expect(backend.cwd).toBe(frontend.cwd); // same directory…
    expect(backend.sessionId).not.toBe(frontend.sessionId); // …different conversations
  }, 30_000);

  it('re-hydrates each agent into its OWN session after a serve restart', async () => {
    const { db, tm, team, workers, wsBase, adminToken } = await setup();
    await tm.spawnAgent(team.id, agentSpec('@backend'));
    await tm.spawnAgent(team.id, agentSpec('@frontend'));
    const idBefore = {
      backend: lastSpawnOf(workers, '@backend').sessionId,
      frontend: lastSpawnOf(workers, '@frontend').sessionId,
    };

    // The real serve-shutdown path: agents killed, teams left active, specs kept.
    await tm.drainAll('test restart');

    // A NEW process comes up on the same DB — new runtime, new adapters, nothing
    // in memory. Everything must come back from SQLite alone.
    const workers2 = new ScriptedWorkers();
    const runtime2 = new AgentRuntime({ gatewayBaseUrl: 'http://127.0.0.1:1' });
    runtime2.register(workers2);
    const bridge2 = new AgentBusBridge({ wsBase, adminToken });
    const tm2 = new TeamManager({ db, runtime: runtime2, bridge: bridge2, bus: { wsBase, adminToken } });

    const back = await tm2.rehydrate();
    expect(back.agents).toBe(2);

    // Each agent resumes ITS id — not a fresh one, and not its teammate's.
    const backend = lastSpawnOf(workers2, '@backend');
    const frontend = lastSpawnOf(workers2, '@frontend');
    expect(backend.sessionId).toBe(idBefore.backend);
    expect(frontend.sessionId).toBe(idBefore.frontend);
    expect(backend.resumeSession).toBe(true);
    expect(frontend.resumeSession).toBe(true);
    expect(backend.sessionId).not.toBe(frontend.sessionId);

    await tm2.drainAll('test cleanup');
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
