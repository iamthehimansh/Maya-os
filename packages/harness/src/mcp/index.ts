/**
 * MCP client (item 11) — public surface. OWNER: @tools.
 *
 * @core wires this in cli.ts:
 *   const hub = await createMcpHub({ cwd, onTools: (ts) => registry.registerAll(ts) });
 *   hub.connect();               // fire-and-forget: tools register as servers land
 *   // …and `await hub.close()` on quit.
 */
export {
  createMcpHub,
  loadMcpConfig,
  formatMcpServers,
  persistMcpServer,
  removePersistedMcpServer,
  parseMcpAddSpec,
} from './hub.js';
export type { McpHub, McpHubOptions, ServerState, ServerStatus, AddServerResult, PersistTarget } from './hub.js';
export { mcpConnectTool, mcpAddHandler, mcpRemoveHandler } from './agent-tool.js';
export { McpClient } from './client.js';
export { StdioTransport, HttpTransport, RpcClient } from './transport.js';
export type { Transport } from './transport.js';
export type {
  McpConfig,
  ServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  McpToolDef,
  McpToolResult,
  McpContentBlock,
} from './types.js';
