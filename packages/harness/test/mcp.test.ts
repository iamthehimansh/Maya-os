/**
 * MCP client (item 11) — end-to-end over a real stdio fixture server, over a
 * real HTTP JSON-RPC server, plus the bridge/naming/flatten logic via a stub
 * transport. Proves tools are discovered, prefixed, callable, and that a broken
 * server degrades gracefully (no throw, error status, no tools).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMcpHub, formatMcpServers } from '../src/mcp/hub.js';
import { RpcClient, type Transport } from '../src/mcp/transport.js';
import type { JsonRpcMessage } from '../src/mcp/types.js';
import type { ToolContext } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'mcp-echo-server.mjs');
const ctx = { cwd: process.cwd(), permission: { async request() { return true; } } } as ToolContext;

let httpServer: Server | undefined;
afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((r) => httpServer!.close(() => r()));
    httpServer = undefined;
  }
});

describe('MCP hub over stdio', () => {
  it('connects, lists prefixed tools, and calls them', async () => {
    const hub = await createMcpHub({
      config: { mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } },
    });
    await hub.connect();

    const states = hub.servers();
    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe('connected');
    expect(states[0]!.toolCount).toBe(3);

    const tools = hub.tools();
    const names = tools.map((t) => t.spec.name).sort();
    expect(names).toEqual(['mcp__echo__add', 'mcp__echo__boom', 'mcp__echo__echo']);

    const echo = tools.find((t) => t.spec.name === 'mcp__echo__echo')!;
    const echoed = await echo.run({ text: 'hi there' }, ctx);
    expect(echoed.content).toBe('hi there');
    expect(echoed.isError).toBeFalsy();

    const add = tools.find((t) => t.spec.name === 'mcp__echo__add')!;
    const sum = await add.run({ a: 2, b: 40 }, ctx);
    expect(sum.content).toBe('42');

    await hub.close();
  });

  it('surfaces MCP tool errors as isError results', async () => {
    const hub = await createMcpHub({
      config: { mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } },
    });
    await hub.connect();
    const boom = hub.tools().find((t) => t.spec.name === 'mcp__echo__boom')!;
    const res = await boom.run({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('kaboom');
    await hub.close();
  });

  it('fires onTools as the server connects', async () => {
    const seen: string[] = [];
    const hub = await createMcpHub({
      config: { mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } },
      onTools: (ts) => seen.push(...ts.map((t) => t.spec.name)),
    });
    await hub.connect();
    expect(seen).toContain('mcp__echo__echo');
    await hub.close();
  });

  it('degrades gracefully when a server cannot start', async () => {
    const hub = await createMcpHub({
      config: { mcpServers: { broken: { command: 'this-command-does-not-exist-xyz', args: [] } } },
    });
    await expect(hub.connect()).resolves.toBeUndefined(); // never throws
    expect(hub.tools()).toHaveLength(0);
    const state = hub.servers()[0]!;
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    await hub.close();
  });
});

describe('MCP hub over HTTP', () => {
  it('connects to a Streamable-HTTP JSON-RPC server and calls a tool', async () => {
    httpServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body);
        const reply = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-fix', version: '1' } });
        else if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); }
        else if (msg.method === 'tools/list') reply({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
        else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: 'pong' }] });
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })); }
      });
    });
    const url = await new Promise<string>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => {
        const addr = httpServer!.address();
        resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`);
      });
    });

    const hub = await createMcpHub({ config: { mcpServers: { remote: { url } } } });
    await hub.connect();
    expect(hub.servers()[0]!.status).toBe('connected');
    const ping = hub.tools().find((t) => t.spec.name === 'mcp__remote__ping')!;
    expect(ping).toBeTruthy();
    const res = await ping.run({}, ctx);
    expect(res.content).toBe('pong');
    await hub.close();
  });
});

describe('formatMcpServers', () => {
  it('renders connected, error, and empty states for /mcp', () => {
    expect(formatMcpServers([])).toContain('No MCP servers');
    const out = formatMcpServers([
      { name: 'echo', status: 'connected', toolCount: 3 },
      { name: 'remote', status: 'error', toolCount: 0, error: 'ECONNREFUSED' },
      { name: 'slow', status: 'connecting', toolCount: 0 },
    ]);
    expect(out).toContain('● echo — connected (3 tools)');
    expect(out).toContain('✗ remote — error: ECONNREFUSED');
    expect(out).toContain('slow — connecting');
  });
});

describe('RpcClient', () => {
  /** A loopback transport that echoes an error response for one method. */
  class StubTransport implements Transport {
    private cb: (m: JsonRpcMessage) => void = () => {};
    async start() {}
    async send(msg: JsonRpcMessage) {
      if ('id' in msg && 'method' in msg) {
        // reply on the next tick
        setImmediate(() => this.cb({ jsonrpc: '2.0', id: (msg as { id: number }).id, result: { ok: true } }));
      }
    }
    onMessage(cb: (m: JsonRpcMessage) => void) { this.cb = cb; }
    onClose() {}
    async close() {}
  }

  it('matches responses to requests by id', async () => {
    const rpc = new RpcClient(new StubTransport());
    const [a, b] = await Promise.all([rpc.request('one'), rpc.request('two')]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it('times out a request with no response', async () => {
    class Silent implements Transport {
      async start() {}
      async send() {}
      onMessage() {}
      onClose() {}
      async close() {}
    }
    const rpc = new RpcClient(new Silent());
    await expect(rpc.request('hang', undefined, 50)).rejects.toThrow(/timed out/);
  });
});
