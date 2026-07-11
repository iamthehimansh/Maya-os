/**
 * MCP client — one connected server. OWNER: @tools.
 *
 * Runs the MCP handshake (initialize → notifications/initialized), lists tools,
 * and calls them. Transport-agnostic: hand it a StdioTransport or HttpTransport.
 */
import { RpcClient, type Transport } from './transport.js';
import type { McpToolDef, McpToolResult } from './types.js';

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  private readonly rpc: RpcClient;
  private connected = false;

  constructor(
    readonly name: string,
    private readonly transport: Transport,
  ) {
    this.rpc = new RpcClient(transport);
  }

  /** Start the transport and perform the MCP initialize handshake. */
  async connect(timeoutMs = 30_000): Promise<void> {
    await this.transport.start();
    await this.rpc.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mayac', version: '0.0.1' },
      },
      timeoutMs,
    );
    await this.rpc.notify('notifications/initialized');
    this.connected = true;
  }

  /** List the server's tools. */
  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.rpc.request('tools/list', {})) as { tools?: McpToolDef[] };
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  /** Invoke a tool by its raw (unprefixed) name. */
  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const res = (await this.rpc.request('tools/call', { name, arguments: args ?? {} })) as McpToolResult;
    return res ?? {};
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.transport.close();
  }
}
