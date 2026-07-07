/**
 * Bus server: one HTTP server carrying both the WebSocket bus
 * (`/ws/bus/:channelId`) and the REST admin API (`/api/*`, Hono).
 *
 * Auth:
 * - WS: token in the subprotocol (`mbt.<token>`) — never in the URL.
 * - REST: `Authorization: Bearer mbt_…` with the `admin` capability.
 *
 * On a fresh database an admin token is minted once and returned from
 * `startBusServer` — it is never persisted in plaintext anywhere.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BusHistoryFrame, BusJoinedFrame, BusPolicyFrame } from '@maya-ai/core';
import { mintToken, SUBPROTOCOL_PREFIX, tokenAllowsChannel, verifyToken, type MintedToken } from './auth.js';
import { BusDb, type TokenRow } from './db.js';
import { parseClientFrame } from './frames.js';
import { Hub, type Conn } from './hub.js';

export interface BusServerOptions {
  /** Port to listen on; 0 = ephemeral (default). */
  port?: number;
  /** Bind host. Localhost by default — LAN exposure must be an explicit choice. */
  host?: string;
  /** SQLite path; ':memory:' for tests. */
  dbPath: string;
}

export interface RunningBusServer {
  port: number;
  db: BusDb;
  /** Present only when this boot created the very first admin token. */
  bootstrapAdminToken?: MintedToken;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;

export async function startBusServer(opts: BusServerOptions): Promise<RunningBusServer> {
  const db = new BusDb(opts.dbPath);
  const hub = new Hub(db);

  let bootstrapAdminToken: MintedToken | undefined;
  if (!db.hasAdminToken()) {
    bootstrapAdminToken = mintToken(db, {
      label: 'admin',
      role: 'owner',
      caps: ['receive', 'send', 'act', 'admin'],
      scopes: ['*'],
    });
  }

  const api = buildAdminApi(db, hub);
  const server = createServer(getRequestListener(api.fetch));
  const wss = new WebSocketServer({ noServer: true });

  // Heartbeat liveness map — a socket that misses two sweeps gets terminated.
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const { channelId, token } = authorizeUpgrade(db, req);
    if (!channelId || !token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // NOTE: handleUpgrade invokes this callback INSTEAD of emitting a
      // 'connection' event — install per-socket listeners (heartbeat pong)
      // here, or they never get installed and the sweep kills live clients.
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      attachConnection(ws, channelId, token, db, hub);
    });
  });

  // Server-side heartbeat: terminate sockets that stop answering pings.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    db,
    ...(bootstrapAdminToken !== undefined ? { bootstrapAdminToken } : {}),
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      hub.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
    },
  };
}

// ── WS plumbing ─────────────────────────────────────────────────────────

function authorizeUpgrade(
  db: BusDb,
  req: IncomingMessage,
): { channelId: string | null; token: TokenRow | null } {
  // Channel ids arrive percent-encoded (clients encodeURIComponent them, e.g.
  // "maya/team/x" → "maya%2Fteam%2Fx"), so allow '%' and decode below.
  const match = /^\/ws\/bus\/([A-Za-z0-9%/_.-]+)$/.exec((req.url ?? '').split('?')[0] ?? '');
  const channelId = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (!channelId) return { channelId: null, token: null };

  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim());
  const raw = protocols.find((p) => p.startsWith(SUBPROTOCOL_PREFIX))?.slice(SUBPROTOCOL_PREFIX.length);
  if (!raw) return { channelId, token: null };

  const token = verifyToken(db, raw);
  if (!token || !token.caps.includes('receive') || !tokenAllowsChannel(token, channelId)) {
    return { channelId, token: null };
  }
  return { channelId, token };
}

function attachConnection(ws: WebSocket, channelId: string, token: TokenRow, db: BusDb, hub: Hub): void {
  const channel = db.getOrCreateChannel(channelId);
  const conn: Conn = hub.join(channelId, randomUUID(), ws, token);

  const joined: BusJoinedFrame = {
    v: 1,
    type: 'joined',
    connectionId: conn.id,
    handle: conn.handle,
    owner: token.label,
    capabilities: token.caps,
  };
  hub.sendTo(conn, joined);

  const policy: BusPolicyFrame = {
    v: 1,
    type: 'policy',
    policyVersion: channel.policyVersion,
    rules: channel.policyRules,
  };
  hub.sendTo(conn, policy);

  const messages = db.history(channelId, conn.handle);
  const history: BusHistoryFrame = { v: 1, type: 'history', count: messages.length, messages };
  hub.sendTo(conn, history);

  ws.on('message', (data) => {
    const parsed = parseClientFrame(data as Buffer | string);
    if ('error' in parsed) {
      hub.sendTo(conn, { type: 'error', code: 'bad_frame', message: parsed.error });
      return;
    }
    const err = hub.handle(conn, parsed.frame);
    if (err) hub.sendTo(conn, { type: 'error', code: 'rejected', message: err });
  });

  ws.on('close', () => hub.leave(conn));
  ws.on('error', () => {
    /* close follows */
  });
}

// ── REST admin API ──────────────────────────────────────────────────────

function buildAdminApi(db: BusDb, hub: Hub): Hono {
  const app = new Hono();

  const requireAdmin = (authorization: string | undefined): TokenRow | null => {
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!raw) return null;
    const token = verifyToken(db, raw);
    return token?.caps.includes('admin') ? token : null;
  };

  app.use('/api/*', async (c, next) => {
    const admin = requireAdmin(c.req.header('authorization'));
    if (!admin) return c.json({ error: 'admin token required' }, 401);
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/tokens', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      label?: string;
      role?: TokenRow['role'];
      caps?: TokenRow['caps'];
      scopes?: string[];
    } | null;
    if (!body?.label) return c.json({ error: 'label required' }, 400);
    const minted = mintToken(db, {
      label: body.label,
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.caps !== undefined ? { caps: body.caps } : {}),
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
    });
    return c.json(minted, 201); // includes the secret — the only time it exists in a response
  });

  app.get('/api/tokens', (c) =>
    c.json(db.listTokens().map(({ id, label, role, caps, scopes, revoked }) => ({ id, label, role, caps, scopes, revoked }))),
  );

  app.delete('/api/tokens/:id', (c) => {
    const ok = db.revokeToken(c.req.param('id'));
    return ok ? c.json({ revoked: true }) : c.json({ error: 'unknown token' }, 404);
  });

  app.get('/api/channels', (c) =>
    c.json(db.listChannels().map((ch) => ({ ...ch, participants: hub.participants(ch.id) }))),
  );

  app.get('/api/channels/:id/history', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    const limit = Number(c.req.query('limit') ?? 500);
    // Private DMs are 1:1 between their two parties — excluded even for
    // admins (protocol guarantee). The sentinel handle matches no participant
    // (real handles never start with a space), and the explicit filter keeps
    // that true even if history() semantics drift.
    const messages = db
      .history(c.req.param('id'), ' none', { afterSeq: after, limit })
      .filter((m) => m.private !== true);
    return c.json({ count: messages.length, messages });
  });

  app.put('/api/channels/:id/policy', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { policyVersion?: string; rules?: string[] } | null;
    if (!body?.policyVersion || !Array.isArray(body.rules)) return c.json({ error: 'policyVersion + rules required' }, 400);
    db.setChannelPolicy(c.req.param('id'), body.policyVersion, body.rules);
    hub.broadcast(c.req.param('id'), { v: 1, type: 'policy', policyVersion: body.policyVersion, rules: body.rules });
    return c.json({ ok: true });
  });

  return app;
}
