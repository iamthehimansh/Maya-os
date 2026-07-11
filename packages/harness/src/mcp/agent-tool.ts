/**
 * MCP runtime control — the `mcp_connect` agent tool + the `/mcp add`/`/mcp
 * remove` slash handlers. OWNER: @tools.
 *
 * `mcp_connect` lets the MODEL configure + connect an MCP server mid-session
 * (its tools register into the live registry immediately) and list/disconnect
 * servers. Backed by the same `McpHub` the CLI wires at startup, so a connect
 * here is indistinguishable from a config-file server. Connect failures come
 * back as `isError` results — they never crash the session.
 *
 * `mcpAddHandler`/`mcpRemoveHandler` build the string-returning closures the TUI
 * consumes as `mcpAdd`/`mcpRemove` props (parse the raw `/mcp add|remove` arg,
 * act on the hub, return a display line).
 */
import type { Tool, ToolContext, ToolResult } from '../types.js';
import {
  formatMcpServers,
  parseMcpAddSpec,
  type AddServerResult,
  type McpHub,
  type PersistTarget,
} from './hub.js';
import type { HttpServerConfig, ServerConfig, StdioServerConfig } from './types.js';

/** One-line human summary of an add() result (shared by the tool + slash handler). */
function summarizeAdd(r: AddServerResult): string {
  if (r.status !== 'connected') {
    return `✗ MCP "${r.name}" failed to connect: ${r.error ?? 'unknown error'}`;
  }
  const persisted = r.persisted ? ' (saved to config)' : '';
  const tools = r.toolNames.length ? `\nTools: ${r.toolNames.join(', ')}` : '';
  return `● MCP "${r.name}" connected — ${r.toolCount} tool${r.toolCount === 1 ? '' : 's'}${persisted}.${tools}`;
}

/** Build a ServerConfig from the tool's structured input, or return an error string. */
function configFromInput(o: Record<string, unknown>): ServerConfig | { error: string } {
  if (typeof o.command === 'string' && o.command) {
    const cfg: StdioServerConfig = { command: o.command };
    if (Array.isArray(o.args)) cfg.args = o.args.filter((a): a is string => typeof a === 'string');
    if (o.env && typeof o.env === 'object') cfg.env = o.env as Record<string, string>;
    return cfg;
  }
  if (typeof o.url === 'string' && o.url) {
    const cfg: HttpServerConfig = { url: o.url };
    if (o.headers && typeof o.headers === 'object') cfg.headers = o.headers as Record<string, string>;
    return cfg;
  }
  return { error: 'provide a "command" (stdio) or a "url" (http/sse) — or a freeform "spec".' };
}

const MCP_CONNECT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['connect', 'list', 'disconnect'],
      description: 'connect a new server (default), list connected servers, or disconnect one.',
    },
    name: { type: 'string', description: 'Server name (required for connect/disconnect). Becomes the mcp__<name>__* prefix.' },
    command: { type: 'string', description: 'For a stdio server: the executable to launch (e.g. "npx", "node").' },
    args: { type: 'array', items: { type: 'string' }, description: 'For a stdio server: command arguments.' },
    env: { type: 'object', description: 'For a stdio server: extra environment variables.', additionalProperties: { type: 'string' } },
    url: { type: 'string', description: 'For an http/SSE server: the endpoint URL.' },
    headers: { type: 'object', description: 'For an http server: extra request headers.', additionalProperties: { type: 'string' } },
    spec: {
      type: 'string',
      description: 'Alternative to the structured fields: a freeform spec like "<name> npx -y @scope/server", "<name> https://host/mcp", or inline JSON.',
    },
    persist: { type: 'boolean', description: 'Also save this server to config so it reconnects next launch (default false — session-only).' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

/** The model-facing `mcp_connect` tool, backed by the live hub. */
export function mcpConnectTool(hub: McpHub): Tool {
  return {
    spec: {
      name: 'mcp_connect',
      description:
        'Configure and connect an MCP server at runtime so its tools become available to you immediately (named mcp__<name>__*). ' +
        'Actions: "connect" adds a server (give a name plus either command/args/env for stdio OR url/headers for http/SSE — or a freeform "spec"); ' +
        '"list" shows connected servers and their status; "disconnect" removes one by name. ' +
        'Set persist:true to also save it for next launch. Connect failures are reported, not thrown.',
      inputSchema: MCP_CONNECT_SCHEMA,
    },
    async run(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const o = (input ?? {}) as Record<string, unknown>;
      const action = typeof o.action === 'string' ? o.action : 'connect';

      try {
        if (action === 'list') {
          return { content: formatMcpServers(hub.servers()) };
        }

        if (action === 'disconnect') {
          const name = typeof o.name === 'string' ? o.name.trim() : '';
          if (!name) return { content: 'disconnect needs a server "name".', isError: true };
          const persist = o.persist === true;
          const removed = await hub.remove(name, persist ? { persist: true } : undefined);
          return removed
            ? { content: `Disconnected MCP "${name}"${persist ? ' and removed it from config' : ''}.` }
            : { content: `No MCP server named "${name}".`, isError: true };
        }

        if (action === 'connect') {
          // Prefer the freeform spec when given; else assemble from structured fields.
          let name: string;
          let config: ServerConfig;
          if (typeof o.spec === 'string' && o.spec.trim()) {
            const parsed = parseMcpAddSpec(o.spec);
            if ('error' in parsed) return { content: parsed.error, isError: true };
            name = parsed.name;
            config = parsed.config;
          } else {
            name = typeof o.name === 'string' ? o.name.trim() : '';
            if (!name) return { content: 'connect needs a server "name".', isError: true };
            const built = configFromInput(o);
            if ('error' in built) return { content: built.error, isError: true };
            config = built;
          }

          const persist: PersistTarget | boolean = o.persist === true;
          const result = await hub.add(name, config, persist ? { persist } : undefined);
          return { content: summarizeAdd(result), ...(result.status !== 'connected' ? { isError: true } : {}) };
        }

        return { content: `unknown action "${action}"`, isError: true };
      } catch (e) {
        return { content: `mcp_connect failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };
}

// ─────────────────────────────────────────────── slash handlers (for TUI) ───

/**
 * Build the `mcpAdd(spec)` handler the TUI wires as a prop. Parses the raw
 * `/mcp add` arg, connects live, persists to project config, returns a display
 * line. Never throws.
 */
export function mcpAddHandler(hub: McpHub): (spec: string) => Promise<string> {
  return async (spec: string) => {
    const parsed = parseMcpAddSpec(spec);
    if ('error' in parsed) return parsed.error;
    const result = await hub.add(parsed.name, parsed.config, { persist: true });
    return summarizeAdd(result);
  };
}

/** Build the `mcpRemove(name)` handler the TUI wires as a prop. */
export function mcpRemoveHandler(hub: McpHub): (name: string) => Promise<string> {
  return async (name: string) => {
    const key = (name ?? '').trim();
    if (!key) return 'usage: /mcp remove <name>';
    const removed = await hub.remove(key, { persist: true });
    return removed ? `Removed MCP "${key}" (disconnected + dropped from config).` : `No MCP server named "${key}".`;
  };
}
