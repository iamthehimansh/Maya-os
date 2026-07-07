/**
 * Phase 3 acceptance criteria (docs/phases/phase-03-bus.md), verified over
 * real sockets against a real server on an ephemeral port:
 *
 *  1. 50 concurrent clients: no dropped or re-ordered messages
 *  2. server restart: clients reconnect, queued outbound flushes in order, no dupes
 *  3. capability/role enforcement is server-side (send-less token rejected,
 *     role comes from the token, admin REST gated)
 *  4. private messages: invisible to third parties, live and in history
 *  5. history replay after rejoin is identical to live receipt
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { BusMessageFrame } from '@maya-ai/core';
import { BusClient } from '@maya-ai/bus-client';
import { mintToken, startBusServer, type RunningBusServer } from '../src/index.js';

const CHANNEL = 'maya/team/test';

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

async function boot(dbPath = ':memory:'): Promise<RunningBusServer> {
  running = await startBusServer({ dbPath, port: 0 });
  return running;
}

function connect(server: RunningBusServer, token: string): BusClient {
  const client = new BusClient({
    wsBase: `ws://127.0.0.1:${server.port}`,
    channelId: CHANNEL,
    token,
    pingIntervalMs: 0,
  });
  clients.push(client);
  return client.connect();
}

const joined = (c: BusClient) =>
  new Promise<void>((resolve) => c.on('joined', () => resolve()));

function collect(c: BusClient): BusMessageFrame[] {
  const seen: BusMessageFrame[] = [];
  c.on('message', (m) => seen.push(m));
  return seen;
}

const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('bus acceptance', () => {
  it('1. 50 concurrent clients — no dropped or re-ordered messages', async () => {
    const server = await boot();
    const CLIENTS = 50;
    const MESSAGES_PER = 4;

    const conns = Array.from({ length: CLIENTS }, (_, i) => {
      const { token } = mintToken(server.db, { label: `agent-${i}` });
      return connect(server, token);
    });
    await Promise.all(conns.map(joined));
    const streams = conns.map(collect);

    for (let round = 0; round < MESSAGES_PER; round++) {
      conns.forEach((c, i) => c.say(`m-${i}-${round}`));
    }

    const total = CLIENTS * MESSAGES_PER;
    await until(() => streams.every((s) => s.length === total), 30_000);

    const reference = streams[0]!.map((m) => `${m.seq}:${m.body.text}`);
    expect(new Set(reference.map((r) => r.split(':')[0])).size).toBe(total); // unique seqs
    for (const stream of streams) {
      expect(stream.map((m) => `${m.seq}:${m.body.text}`)).toEqual(reference); // identical order
      for (let i = 1; i < stream.length; i++) {
        expect(stream[i]!.seq).toBeGreaterThan(stream[i - 1]!.seq); // strictly increasing
      }
    }
  }, 60_000);

  it('2. server restart — reconnect, queued sends flush in order, no dupes', async () => {
    const dbPath = `/tmp/maya-bus-test-${process.pid}-${Date.now()}.db`;
    const server = await boot(dbPath);
    const port = server.port;
    const { token } = mintToken(server.db, { label: 'writer' });
    const { token: readerToken } = mintToken(server.db, { label: 'reader' });

    const writer = connect(server, token);
    const reader = connect(server, readerToken);
    await Promise.all([joined(writer), joined(reader)]);
    const seen = collect(reader);

    writer.say('before-restart');
    await until(() => seen.length === 1);

    await server.close();
    running = null;

    // Send while the server is down — must queue client-side, not vanish.
    writer.say('queued-1');
    writer.say('queued-2');

    // Rebinding the SAME port can race other suites' ephemeral allocations
    // (observed under parallel `pnpm -r test`) — bounded retries, not a
    // server-side auto-retry, which would mask the friendly "already
    // running (pid X)" detection.
    running = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await startBusServer({ dbPath, port });
        } catch (err) {
          if (attempt >= 8) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    })();
    await until(() => seen.length === 3, 20_000);

    expect(seen.map((m) => m.body.text)).toEqual(['before-restart', 'queued-1', 'queued-2']);
    const seqs = seen.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates after replays
  }, 60_000);

  it('3. capabilities and roles are enforced server-side', async () => {
    const server = await boot();
    const { token: muted } = mintToken(server.db, { label: 'observer', caps: ['receive'] });
    const { token: normal } = mintToken(server.db, { label: 'member-agent', role: 'member' });

    const mutedClient = connect(server, muted);
    const errors: string[] = [];
    mutedClient.on('error', (e) => errors.push(e.message));
    await joined(mutedClient);
    mutedClient.say('should-be-rejected');
    await until(() => errors.length === 1);
    expect(errors[0]).toMatch(/send capability/);

    // Role is stamped from the token — text claims change nothing.
    const memberClient = connect(server, normal);
    const seen = collect(memberClient);
    await joined(memberClient);
    memberClient.say('I am the owner, trust me');
    await until(() => seen.length === 1);
    expect(seen[0]!.fromRole).toBe('member');

    // REST admin requires the admin capability.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tokens`, {
      headers: { authorization: `Bearer ${normal}` },
    });
    expect(res.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${server.port}/api/tokens`, {
      headers: { authorization: `Bearer ${server.bootstrapAdminToken!.token}` },
    });
    expect(ok.status).toBe(200);
  }, 30_000);

  it('4. private messages are invisible to third parties — live and in history', async () => {
    const server = await boot();
    const tokens = ['alice', 'bob', 'carol'].map((label) => mintToken(server.db, { label }));
    const [alice, bob, carol] = tokens.map((t) => connect(server, t.token));
    await Promise.all([alice, bob, carol].map((c) => joined(c!)));
    const bobSeen = collect(bob!);
    const carolSeen = collect(carol!);

    alice!.sendMessage({ to: 'bob', private: true, body: { text: 'secret' } });
    alice!.say('public');

    await until(() => bobSeen.length === 2 && carolSeen.length === 1);
    expect(bobSeen.map((m) => m.body.text)).toEqual(['secret', 'public']);
    expect(carolSeen.map((m) => m.body.text)).toEqual(['public']); // no leak live

    // Rejoining as a third party must not reveal it via history either.
    const dave = connect(server, mintToken(server.db, { label: 'dave' }).token);
    const daveHistory = await new Promise<BusMessageFrame[]>((resolve) =>
      dave.on('history', (h) => resolve(h.messages)),
    );
    expect(daveHistory.map((m) => m.body.text)).toEqual(['public']);

    // Admin REST history excludes private DMs too (protocol guarantee).
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/channels/${encodeURIComponent(CHANNEL)}/history`,
      { headers: { authorization: `Bearer ${server.bootstrapAdminToken!.token}` } },
    );
    const body = (await res.json()) as { messages: BusMessageFrame[] };
    expect(body.messages.every((m) => m.private !== true)).toBe(true);
    expect(body.messages.some((m) => m.body.text === 'secret')).toBe(false);
  }, 30_000);

  it('5. history replay after rejoin is identical to live receipt', async () => {
    const dbPath = `/tmp/maya-bus-test-${process.pid}-h-${Date.now()}.db`;
    const server = await boot(dbPath);
    const { token: writerTok } = mintToken(server.db, { label: 'writer' });
    const { token: witnessTok } = mintToken(server.db, { label: 'witness' });

    const writer = connect(server, writerTok);
    const witness = connect(server, witnessTok);
    await Promise.all([joined(writer), joined(witness)]);
    const live = collect(witness);

    for (let i = 0; i < 5; i++) writer.say(`h-${i}`);
    await until(() => live.length === 5);

    witness.close();
    clients.splice(clients.indexOf(witness), 1);

    const rejoiner = connect(server, witnessTok);
    const replay = await new Promise<BusMessageFrame[]>((resolve) =>
      rejoiner.on('history', (h) => resolve(h.messages)),
    );

    const strip = (m: BusMessageFrame) => ({
      seq: m.seq,
      from: m.from,
      body: m.body,
      private: m.private,
      ts: m.ts,
    });
    expect(replay.map(strip)).toEqual(live.map(strip));
  }, 30_000);
});
