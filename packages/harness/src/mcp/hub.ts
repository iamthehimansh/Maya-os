/**
 * MCP hub — connect configured servers and bridge their tools into the harness
 * Tool registry (item 11). OWNER: @tools.
 *
 * `createMcpHub()` discovers `mayac.config.json` (cwd) + `~/.mayac/config.json`
 * (project overrides global), connects each server, and exposes their tools as
 * plain harness `Tool`s named `mcp__<server>__<tool>`. Connection is resilient:
 * one server failing never blocks the others, and errors surface in `servers()`.
 * @core merges `hub.tools()` into the registry; an optional `onTools` callback
 * lets late-connecting servers register live.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { McpClient } from './client.js';
import { HttpTransport, StdioTransport, type Transport } from './transport.js';
import {
  isHttp,
  isStdio,
  type HttpServerConfig,
  type McpConfig,
  type McpContentBlock,
  type McpToolResult,
  type ServerConfig,
  type StdioServerConfig,
} from './types.js';

export type ServerStatus = 'connecting' | 'connected' | 'error';

export interface ServerState {
  name: string;
  status: ServerStatus;
  toolCount: number;
  error?: string;
}

/** Render server states for a `/mcp` slash command (mirrors memory's formatMemoryView). */
export function formatMcpServers(states: readonly ServerState[]): string {
  if (states.length === 0) return 'No MCP servers configured. Add them to mayac.config.json or ~/.mayac/config.json.';
  const icon = (s: ServerStatus) => (s === 'connected' ? '●' : s === 'error' ? '✗' : '…');
  return states
    .map((s) => {
      const head = `${icon(s.status)} ${s.name} — ${s.status}`;
      if (s.status === 'connected') return `${head} (${s.toolCount} tool${s.toolCount === 1 ? '' : 's'})`;
      if (s.status === 'error') return `${head}: ${s.error ?? 'unknown error'}`;
      return head;
    })
    .join('\n');
}

/** Where a runtime-added server is written so it reconnects next launch. */
export type PersistTarget = 'project' | 'global';

/** Result of a runtime `add()` — enough for `/mcp add` and the `mcp_connect` tool to report. */
export interface AddServerResult {
  name: string;
  status: ServerStatus;
  toolCount: number;
  /** Prefixed tool names now registered (e.g. "mcp__foo__bar"). */
  toolNames: string[];
  /** Present when the connect failed (server unreachable, bad command, etc.). */
  error?: string;
  /** Whether the config was written to disk (persist requested AND succeeded). */
  persisted?: boolean;
}

export interface McpHub {
  /** Connect every configured server (in parallel); resolves when all settle. */
  connect(): Promise<void>;
  /** All currently-bridged tools. */
  tools(): Tool[];
  /** Per-server connection state (for `/mcp` reporting). */
  servers(): ServerState[];
  /**
   * Configure + connect ONE server live — its tools register into the agent's
   * registry immediately (via `onTools`). Replaces a same-named server cleanly.
   * `persist` writes it to config so it reconnects next launch. NEVER throws — a
   * failed connect comes back as a result with `status:'error'`.
   */
  add(name: string, config: ServerConfig, opts?: { persist?: boolean | PersistTarget }): Promise<AddServerResult>;
  /**
   * Disconnect a server, unregister its tools (via `onRemoveTools`), and drop it
   * from persisted config when `persist`. Returns true if the server existed.
   */
  remove(name: string, opts?: { persist?: boolean | PersistTarget }): Promise<boolean>;
  /** Disconnect every server. */
  close(): Promise<void>;
}

export interface McpHubOptions {
  /** Explicit config (skips file discovery — used by tests). */
  config?: McpConfig;
  /** Directory to look for `mayac.config.json` in (default: process.cwd()). */
  cwd?: string;
  /** Called with the newly-bridged tools each time a server connects (live registration). */
  onTools?: (tools: Tool[]) => void;
  /** Called with tool names to drop when a server is removed/replaced (live unregistration). */
  onRemoveTools?: (toolNames: string[]) => void;
  /** Progress/diagnostics sink. */
  onLog?: (msg: string) => void;
  /** Build a transport for a config — injectable so tests can stub the wire. */
  transportFactory?: (name: string, cfg: ServerConfig) => Transport;
}

/** Flatten an MCP tools/call result into the harness ToolResult string. */
function flattenResult(res: McpToolResult): ToolResult {
  const blocks: McpContentBlock[] = Array.isArray(res.content) ? res.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push(`[image ${(b as { mimeType?: string }).mimeType ?? ''}]`.trim());
    else if (b.type === 'resource') parts.push(`[resource ${(b as { resource?: { uri?: string } }).resource?.uri ?? ''}]`.trim());
    else parts.push(JSON.stringify(b));
  }
  const content = parts.join('\n') || (res.isError ? '(tool error, no content)' : '(no content)');
  return { content, ...(res.isError ? { isError: true } : {}) };
}

function makeTransport(name: string, cfg: ServerConfig): Transport {
  if (isStdio(cfg)) return new StdioTransport(cfg);
  if (isHttp(cfg)) return new HttpTransport(cfg);
  throw new Error(`server "${name}" has neither a command (stdio) nor a url (http)`);
}

/** Bridge one server's MCP tools into harness Tools, prefixed to avoid collisions. */
function bridgeTools(serverName: string, client: McpClient, defs: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]): Tool[] {
  return defs.map((def) => ({
    spec: {
      name: `mcp__${serverName}__${def.name}`,
      description: def.description ?? `MCP tool "${def.name}" from server "${serverName}".`,
      inputSchema: def.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
    },
    async run(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      try {
        const res = await client.callTool(def.name, input);
        return flattenResult(res);
      } catch (e) {
        return { content: `MCP call failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  }));
}

class McpHubImpl implements McpHub {
  /** name → live client, so remove()/replace can close exactly one. */
  private readonly clients = new Map<string, McpClient>();
  private readonly bridged = new Map<string, Tool[]>();
  private readonly states = new Map<string, ServerState>();

  constructor(
    private readonly servers_: Record<string, ServerConfig>,
    private readonly opts: McpHubOptions,
  ) {
    for (const name of Object.keys(servers_)) {
      this.states.set(name, { name, status: 'connecting', toolCount: 0 });
    }
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  private get cwd(): string {
    return this.opts.cwd ?? process.cwd();
  }

  async connect(): Promise<void> {
    await Promise.all(
      Object.entries(this.servers_).map(([name, cfg]) => this.connectOne(name, cfg)),
    );
  }

  private async connectOne(name: string, cfg: ServerConfig): Promise<void> {
    const factory = this.opts.transportFactory ?? makeTransport;
    let client: McpClient | undefined;
    try {
      const transport = factory(name, cfg);
      client = new McpClient(name, transport);
      await client.connect();
      const defs = await client.listTools();
      const tools = bridgeTools(name, client, defs);
      this.clients.set(name, client);
      this.bridged.set(name, tools);
      this.states.set(name, { name, status: 'connected', toolCount: tools.length });
      this.log(`MCP "${name}" connected — ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
      if (tools.length) this.opts.onTools?.(tools);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.states.set(name, { name, status: 'error', toolCount: 0, error });
      this.log(`MCP "${name}" failed: ${error}`);
      try { await client?.close(); } catch { /* ignore */ }
    }
  }

  /** Close one server's client and drop its bridged tools (unregistering them live). */
  private async disconnectOne(name: string): Promise<void> {
    const tools = this.bridged.get(name);
    if (tools?.length) this.opts.onRemoveTools?.(tools.map((t) => t.spec.name));
    this.bridged.delete(name);
    const client = this.clients.get(name);
    this.clients.delete(name);
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  async add(name: string, config: ServerConfig, opts?: { persist?: boolean | PersistTarget }): Promise<AddServerResult> {
    const key = name.trim();
    if (!key) return { name, status: 'error', toolCount: 0, toolNames: [], error: 'server name is required' };
    // Replacing an existing server: tear the old one down first so its tools swap cleanly.
    if (this.clients.has(key) || this.bridged.has(key)) await this.disconnectOne(key);

    this.servers_[key] = config;
    this.states.set(key, { name: key, status: 'connecting', toolCount: 0 });
    await this.connectOne(key, config);

    const state = this.states.get(key)!;
    const toolNames = (this.bridged.get(key) ?? []).map((t) => t.spec.name);

    let persisted = false;
    if (opts?.persist && state.status === 'connected') {
      const target: PersistTarget = opts.persist === 'global' ? 'global' : 'project';
      try {
        await persistMcpServer(key, config, this.cwd, target);
        persisted = true;
      } catch (e) {
        this.log(`MCP "${key}" persist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      name: key,
      status: state.status,
      toolCount: state.toolCount,
      toolNames,
      ...(state.error ? { error: state.error } : {}),
      ...(opts?.persist ? { persisted } : {}),
    };
  }

  async remove(name: string, opts?: { persist?: boolean | PersistTarget }): Promise<boolean> {
    const key = name.trim();
    const existed = this.states.has(key) || this.clients.has(key) || key in this.servers_;
    if (!existed) return false;
    await this.disconnectOne(key);
    this.states.delete(key);
    delete this.servers_[key];
    if (opts?.persist) {
      const target: PersistTarget = opts.persist === 'global' ? 'global' : 'project';
      try {
        await removePersistedMcpServer(key, this.cwd, target);
      } catch (e) {
        this.log(`MCP "${key}" unpersist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return true;
  }

  tools(): Tool[] {
    return [...this.bridged.values()].flat();
  }

  servers(): ServerState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
    this.bridged.clear();
  }
}

/** Load + merge MCP config: global (`~/.mayac/config.json`) then project (`<cwd>/mayac.config.json`). */
export async function loadMcpConfig(cwd = process.cwd()): Promise<McpConfig> {
  const paths = [join(homedir(), '.mayac', 'config.json'), join(cwd, 'mayac.config.json')];
  const merged: Record<string, ServerConfig> = {};
  for (const p of paths) {
    try {
      const parsed = JSON.parse(await readFile(p, 'utf8')) as McpConfig;
      Object.assign(merged, parsed.mcpServers ?? {});
    } catch {
      /* missing/invalid file — skip */
    }
  }
  return { mcpServers: merged };
}

/**
 * Create a hub from explicit config or discovered files. Does NOT connect — call
 * `hub.connect()` (await at startup, or fire-and-forget for live registration).
 */
export async function createMcpHub(opts: McpHubOptions = {}): Promise<McpHub> {
  const config = opts.config ?? (await loadMcpConfig(opts.cwd));
  return new McpHubImpl(config.mcpServers ?? {}, opts);
}

// ──────────────────────────────────────────────── runtime persistence ───────

/** Absolute path of the config we persist a runtime-added server into. */
function persistPath(target: PersistTarget, cwd: string): string {
  return target === 'global' ? join(homedir(), '.mayac', 'config.json') : join(cwd, 'mayac.config.json');
}

/** Read a config file, tolerating a missing/corrupt file (→ empty). */
async function readConfigFile(path: string): Promise<McpConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as McpConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Upsert one server into a config file (project by default), creating it if absent. */
export async function persistMcpServer(
  name: string,
  config: ServerConfig,
  cwd = process.cwd(),
  target: PersistTarget = 'project',
): Promise<void> {
  const path = persistPath(target, cwd);
  const cfg = await readConfigFile(path);
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: config };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Drop one server from a config file. Returns false if the file/entry was absent. */
export async function removePersistedMcpServer(
  name: string,
  cwd = process.cwd(),
  target: PersistTarget = 'project',
): Promise<boolean> {
  const path = persistPath(target, cwd);
  const cfg = await readConfigFile(path);
  if (!cfg.mcpServers || !(name in cfg.mcpServers)) return false;
  delete cfg.mcpServers[name];
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return true;
}

// ──────────────────────────────────────────────── spec parsing (UX) ─────────

/**
 * Parse a `/mcp add` / `mcp_connect` spec into `{ name, config }`. Accepts, in
 * order of precedence:
 *   1. inline JSON with a `name` field:  `{"name":"foo","command":"node","args":["x.mjs"]}`
 *      or `{"name":"foo","url":"https://..."}`
 *   2. `<name> <json>`:                  `foo {"command":"node","args":["x.mjs"]}`
 *   3. `<name> <http(s)-url>`:            `foo https://host/mcp`
 *   4. `<name> <command> [args...]`:      `foo npx -y @scope/server`
 * Returns `{ error }` (never throws) on anything it can't make sense of.
 */
export function parseMcpAddSpec(arg: string): { name: string; config: ServerConfig } | { error: string } {
  const trimmed = (arg ?? '').trim();
  if (!trimmed) return { error: 'usage: /mcp add <name> <command …|url|json>  (or inline JSON with a "name")' };

  // (1) Whole-arg JSON object carrying its own name.
  if (trimmed.startsWith('{')) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (e) {
      return { error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) return { error: 'JSON config needs a "name" field' };
    const { name: _drop, ...rest } = obj;
    return coerceConfig(name, rest);
  }

  // Otherwise: first token is the name, the remainder is the spec.
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { error: `server "${trimmed}" needs a command, url, or JSON config after the name` };
  const name = trimmed.slice(0, spaceIdx);
  const rest = trimmed.slice(spaceIdx + 1).trim();

  // (2) `<name> <json>`
  if (rest.startsWith('{')) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(rest) as Record<string, unknown>;
    } catch (e) {
      return { error: `invalid JSON for "${name}": ${e instanceof Error ? e.message : String(e)}` };
    }
    return coerceConfig(name, obj);
  }

  // (3) `<name> <http(s)-url>`
  if (/^https?:\/\//i.test(rest)) {
    return { name, config: { url: rest } as HttpServerConfig };
  }

  // (4) `<name> <command> [args...]`
  const parts = rest.split(/\s+/);
  const command = parts[0]!;
  const args = parts.slice(1);
  return { name, config: { command, ...(args.length ? { args } : {}) } as StdioServerConfig };
}

/** Validate a parsed object into a ServerConfig (stdio needs command; http needs url). */
function coerceConfig(name: string, obj: Record<string, unknown>): { name: string; config: ServerConfig } | { error: string } {
  if (typeof obj.command === 'string' && obj.command) {
    const cfg: StdioServerConfig = { command: obj.command };
    if (Array.isArray(obj.args)) cfg.args = obj.args.filter((a): a is string => typeof a === 'string');
    if (obj.env && typeof obj.env === 'object') cfg.env = obj.env as Record<string, string>;
    if (typeof obj.cwd === 'string') cfg.cwd = obj.cwd;
    return { name, config: cfg };
  }
  if (typeof obj.url === 'string' && obj.url) {
    const cfg: HttpServerConfig = { url: obj.url };
    if (obj.headers && typeof obj.headers === 'object') cfg.headers = obj.headers as Record<string, string>;
    if (obj.type === 'http' || obj.type === 'sse') cfg.type = obj.type;
    return { name, config: cfg };
  }
  return { error: `server "${name}" config needs a "command" (stdio) or a "url" (http/sse)` };
}
