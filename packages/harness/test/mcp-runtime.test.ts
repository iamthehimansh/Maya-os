/**
 * MCP runtime control (item: runtime configure + connect). OWNER: @tools.
 *
 * Proves: hub.add() connects a live stdio server and its tools appear + register
 * via onTools; persist writes the server into project config; hub.remove()
 * disconnects + unregisters (onRemoveTools) + unpersists; parseMcpAddSpec accepts
 * every input shape; the `mcp_connect` agent tool connects/lists/disconnects; the
 * /mcp add|remove slash handlers return status strings; and the tools register.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMcpHub, parseMcpAddSpec, type McpHub } from '../src/mcp/hub.js';
import { mcpConnectTool, mcpAddHandler, mcpRemoveHandler } from '../src/mcp/agent-tool.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type { Tool, ToolContext } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'mcp-echo-server.mjs');
const ctx = { cwd: process.cwd(), permission: { async request() { return true; } } } as ToolContext;
const stdioCfg = { command: process.execPath, args: [FIXTURE] };

const tmpDirs: string[] = [];
const mkTmp = () => { const d = mkdtempSync(join(tmpdir(), 'mayac-mcp-')); tmpDirs.push(d); return d; };

let hub: McpHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('hub.add / remove (runtime connect)', () => {
  it('connects a server live, registers its tools, and reports them', async () => {
    const registered: string[] = [];
    hub = await createMcpHub({ config: { mcpServers: {} }, onTools: (ts) => registered.push(...ts.map((t) => t.spec.name)) });
    const res = await hub.add('echo', stdioCfg);
    expect(res.status).toBe('connected');
    expect(res.toolCount).toBe(3);
    expect(res.toolNames).toContain('mcp__echo__echo');
    expect(registered).toContain('mcp__echo__echo');

    const echo = hub.tools().find((t) => t.spec.name === 'mcp__echo__echo')!;
    expect((await echo.run({ text: 'hey' }, ctx)).content).toBe('hey');
  });

  it('persists to <cwd>/mayac.config.json and reconnects from it', async () => {
    const cwd = mkTmp();
    hub = await createMcpHub({ config: { mcpServers: {} }, cwd });
    const res = await hub.add('echo', stdioCfg, { persist: true });
    expect(res.persisted).toBe(true);

    const path = join(cwd, 'mayac.config.json');
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.mcpServers.echo.command).toBe(process.execPath);

    // A fresh hub built from the discovered file connects the same server.
    const hub2 = await createMcpHub({ cwd });
    await hub2.connect();
    expect(hub2.servers().find((s) => s.name === 'echo')!.status).toBe('connected');
    await hub2.close();
  });

  it('does not persist a failed connect', async () => {
    const cwd = mkTmp();
    hub = await createMcpHub({ config: { mcpServers: {} }, cwd });
    const res = await hub.add('broken', { command: 'this-cmd-does-not-exist-xyz' }, { persist: true });
    expect(res.status).toBe('error');
    expect(res.persisted).toBe(false);
    expect(existsSync(join(cwd, 'mayac.config.json'))).toBe(false);
  });

  it('remove() disconnects, unregisters tools, and drops persisted config', async () => {
    const cwd = mkTmp();
    const removed: string[] = [];
    hub = await createMcpHub({ config: { mcpServers: {} }, cwd, onRemoveTools: (n) => removed.push(...n) });
    await hub.add('echo', stdioCfg, { persist: true });

    const ok = await hub.remove('echo', { persist: true });
    expect(ok).toBe(true);
    expect(removed).toContain('mcp__echo__echo');
    expect(hub.tools()).toHaveLength(0);
    expect(hub.servers().find((s) => s.name === 'echo')).toBeUndefined();

    const saved = JSON.parse(readFileSync(join(cwd, 'mayac.config.json'), 'utf8'));
    expect(saved.mcpServers.echo).toBeUndefined();

    expect(await hub.remove('nope')).toBe(false);
  });
});

describe('parseMcpAddSpec', () => {
  it('parses <name> <command> [args...]', () => {
    const r = parseMcpAddSpec('echo node server.mjs --flag');
    expect(r).toEqual({ name: 'echo', config: { command: 'node', args: ['server.mjs', '--flag'] } });
  });
  it('parses <name> <http-url>', () => {
    const r = parseMcpAddSpec('remote https://host/mcp');
    expect(r).toEqual({ name: 'remote', config: { url: 'https://host/mcp' } });
  });
  it('parses <name> <json>', () => {
    const r = parseMcpAddSpec('foo {"command":"npx","args":["-y","x"]}');
    expect(r).toEqual({ name: 'foo', config: { command: 'npx', args: ['-y', 'x'] } });
  });
  it('parses whole-arg JSON carrying its own name', () => {
    const r = parseMcpAddSpec('{"name":"bar","url":"https://h/mcp","headers":{"x":"1"}}');
    expect(r).toEqual({ name: 'bar', config: { url: 'https://h/mcp', headers: { x: '1' } } });
  });
  it('returns an error for empty / nameless / config-less input', () => {
    expect('error' in parseMcpAddSpec('')).toBe(true);
    expect('error' in parseMcpAddSpec('{"url":"https://h"}')).toBe(true); // no name
    expect('error' in parseMcpAddSpec('lonely')).toBe(true); // no command/url
    expect('error' in parseMcpAddSpec('bad {not json}')).toBe(true);
    expect('error' in parseMcpAddSpec('x {"foo":1}')).toBe(true); // no command/url in json
  });
});

describe('mcp_connect agent tool', () => {
  it('is named mcp_connect and registers into a tool registry', () => {
    hubStub();
    const tool = mcpConnectTool(hubStub());
    expect(tool.spec.name).toBe('mcp_connect');
    const reg = createToolRegistry([tool]);
    expect(reg.get('mcp_connect')).toBeTruthy();
    expect(reg.list().map((t: Tool) => t.spec.name)).toContain('mcp_connect');
  });

  it('connects via structured fields and lets the model call the new tool', async () => {
    hub = await createMcpHub({ config: { mcpServers: {} } });
    const tool = mcpConnectTool(hub);
    const res = await tool.run({ action: 'connect', name: 'echo', command: process.execPath, args: [FIXTURE] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('connected');
    expect(hub.tools().some((t) => t.spec.name === 'mcp__echo__echo')).toBe(true);
  });

  it('connects via a freeform spec, lists, then disconnects', async () => {
    hub = await createMcpHub({ config: { mcpServers: {} } });
    const tool = mcpConnectTool(hub);
    const spec = `echo ${process.execPath} ${FIXTURE}`;
    const add = await tool.run({ action: 'connect', spec }, ctx);
    expect(add.content).toContain('connected');

    const list = await tool.run({ action: 'list' }, ctx);
    expect(list.content).toContain('echo');

    const off = await tool.run({ action: 'disconnect', name: 'echo' }, ctx);
    expect(off.content).toContain('Disconnected');
    expect(hub.tools()).toHaveLength(0);
  });

  it('reports a bad connect as an error, never throwing', async () => {
    hub = await createMcpHub({ config: { mcpServers: {} } });
    const tool = mcpConnectTool(hub);
    const res = await tool.run({ action: 'connect', name: 'broken', command: 'this-cmd-does-not-exist-xyz' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('failed to connect');
  });

  it('validates missing name / config', async () => {
    hub = await createMcpHub({ config: { mcpServers: {} } });
    const tool = mcpConnectTool(hub);
    expect((await tool.run({ action: 'connect', name: 'x' }, ctx)).isError).toBe(true);
    expect((await tool.run({ action: 'disconnect' }, ctx)).isError).toBe(true);
  });
});

describe('/mcp add + remove slash handlers', () => {
  it('mcpAdd connects+persists and returns a status line; mcpRemove drops it', async () => {
    const cwd = mkTmp();
    hub = await createMcpHub({ config: { mcpServers: {} }, cwd });
    const add = mcpAddHandler(hub);
    const remove = mcpRemoveHandler(hub);

    const out = await add(`echo ${process.execPath} ${FIXTURE}`);
    expect(out).toContain('connected');
    expect(out).toContain('saved to config');
    expect(existsSync(join(cwd, 'mayac.config.json'))).toBe(true);

    expect(await add('')).toContain('usage'); // empty spec guarded
    expect(await remove('echo')).toContain('Removed');
    expect(await remove('ghost')).toContain('No MCP server');
    expect(await remove('')).toContain('usage');
  });
});

/** A throwaway hub with no servers (for the pure registration assertion). */
function hubStub(): McpHub {
  return {
    async connect() {},
    tools: () => [],
    servers: () => [],
    async add() { return { name: 'x', status: 'connected' as const, toolCount: 0, toolNames: [] }; },
    async remove() { return true; },
    async close() {},
  };
}
