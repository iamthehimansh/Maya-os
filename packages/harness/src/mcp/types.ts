/**
 * MCP client types + config (item 11). OWNER: @tools.
 *
 * Shapes for the `mayac.config.json` / `~/.mayac/config.json` MCP server map and
 * the minimal JSON-RPC / MCP wire types we care about. No dependency on the
 * official SDK — a dependency-free client keeps the harness self-contained.
 */

/** A stdio MCP server: launched as a child process, framed newline-delimited JSON-RPC. */
export interface StdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** An HTTP MCP server: Streamable-HTTP JSON-RPC (also accepts SSE responses). */
export interface HttpServerConfig {
  type?: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfig {
  /** Map of server name → connection config (Claude-Code-compatible `.mcp.json` shape). */
  mcpServers?: Record<string, ServerConfig>;
}

export function isStdio(c: ServerConfig): c is StdioServerConfig {
  return (c as StdioServerConfig).command !== undefined || c.type === 'stdio';
}
export function isHttp(c: ServerConfig): c is HttpServerConfig {
  return (c as HttpServerConfig).url !== undefined || c.type === 'http' || c.type === 'sse';
}

// ───────────────────────────────────────────────────────── JSON-RPC wire ────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─────────────────────────────────────────────────────────── MCP shapes ─────

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A single block of a tools/call result. Text blocks are what we flatten. */
export interface McpContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpToolResult {
  content?: McpContentBlock[];
  isError?: boolean;
}
