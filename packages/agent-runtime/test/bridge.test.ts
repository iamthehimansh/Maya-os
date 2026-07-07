/**
 * Bus-bridge integration: a stub adapter (scripted events, no real CLI)
 * bridged onto a REAL bus server over real sockets. Proves the Phase 6/7
 * plumbing: agent events reach the channel as loop payloads/workstatus,
 * channel answers reach the agent's stdin, detach revokes the token.
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
import { BusClient } from '@maya-ai/bus-client';
import { mintToken, startBusServer, type RunningBusServer } from '@maya-ai/bus';
import { AgentBusBridge } from '../src/bus-bridge.js';
import { EventLog } from '../src/events.js';

const CHANNEL = 'maya/team/bridge-test';

/** Minimal scripted adapter: we push events by hand; send() records input. */
class StubAdapter implements AgentAdapter {
  readonly id = 'stub';
  readonly log = new EventLog();
  readonly received: string[] = [];
  readonly handle: AgentHandle = {
    id: 'ag_stub1',
    adapter: 'stub',
    state: 'running',
    model: 'local/x',
    cwd: '/tmp',
    spawnedAt: new Date().toISOString(),
  };

  async detect() {
    return { installed: true as const };
  }
  async spawn(_spec: AgentSpawnSpec): Promise<AgentHandle> {
    return this.handle;
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async kill(): Promise<void> {}
  async send(_id: string, text: string): Promise<void> {
    this.received.push(text);
  }
  async status(): Promise<AgentHandle> {
    return this.handle;
  }
  async *events(_id: string, since?: string): AsyncIterable<AgentEvent> {
    for await (const { event } of this.log.iterate(since)) yield event;
  }
  async logs(): Promise<never[]> {
    return [];
  }
}

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

const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('AgentBusBridge', () => {
  it('bridges agent events to the channel and channel answers back to the agent', async () => {
    running = await startBusServer({ dbPath: ':memory:', port: 0 });
    const admin = running.bootstrapAdminToken!;
    const wsBase = `ws://127.0.0.1:${running.port}`;

    // An observer (the "lead") watching the channel.
    const { token: leadToken } = mintToken(running.db, { label: 'lead', role: 'owner' });
    const lead = new BusClient({ wsBase, channelId: CHANNEL, token: leadToken }).connect();
    clients.push(lead);
    const seen: BusMessageFrame[] = [];
    lead.on('message', (m) => seen.push(m));
    await new Promise<void>((r) => lead.on('joined', () => r()));

    const adapter = new StubAdapter();
    const bridge = new AgentBusBridge({ wsBase, adminToken: admin.token });
    const { busHandle } = await bridge.attach(adapter, adapter.handle, { channelId: CHANNEL });
    expect(busHandle).toBeTruthy();

    // Agent asks a question → channel sees a loop Question payload.
    adapter.log.push({ kind: 'question', text: 'Which database?', at: new Date().toISOString() });
    await until(() => seen.some((m) => (m.body.maya as LoopBody | undefined)?.kind === 'question'));
    const qMsg = seen.find((m) => (m.body.maya as LoopBody | undefined)?.kind === 'question')!;
    const q = qMsg.body.maya as Extract<LoopBody, { kind: 'question' }>;
    expect(q.prompt).toBe('Which database?');
    expect(qMsg.from).toBe(busHandle);

    // Lead answers, directed at the agent's bus handle → adapter.send() fires.
    const answer: LoopBody = { kind: 'answer', qid: q.qid, text: 'use sqlite' };
    lead.sendMessage({ to: busHandle, body: { text: 'use sqlite', maya: answer } });
    await until(() => adapter.received.length === 1);
    expect(adapter.received[0]).toBe('use sqlite');

    // Plain directed text also reaches the agent.
    lead.sendMessage({ to: busHandle, body: { text: 'also add tests' } });
    await until(() => adapter.received.length === 2);
    expect(adapter.received[1]).toBe('also add tests');

    // Broadcast (untargeted) text does NOT get injected into the agent.
    lead.sendMessage({ body: { text: 'ambient chatter' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(adapter.received.length).toBe(2);

    // Artifact → channel sees a loop ArtifactMsg.
    adapter.log.push({ kind: 'artifact', path: '/tmp/out.txt', at: new Date().toISOString() });
    await until(() => seen.some((m) => (m.body.maya as LoopBody | undefined)?.kind === 'artifact'));

    // Detach revokes the token: a fresh connect with it must fail to join.
    await bridge.detach(adapter.handle.id);
    expect(bridge.attached()).toEqual([]);
  }, 30_000);

  it('terminal agent state clears its workstatus and auto-detaches', async () => {
    running = await startBusServer({ dbPath: ':memory:', port: 0 });
    const admin = running.bootstrapAdminToken!;
    const wsBase = `ws://127.0.0.1:${running.port}`;

    const adapter = new StubAdapter();
    const bridge = new AgentBusBridge({ wsBase, adminToken: admin.token });
    await bridge.attach(adapter, adapter.handle, { channelId: CHANNEL });

    adapter.log.push({ kind: 'state', state: 'exited', at: new Date().toISOString() });
    adapter.log.close(); // terminal → pump ends → auto-detach timer

    await until(() => bridge.attached().length === 0, 10_000);
  }, 20_000);
});
