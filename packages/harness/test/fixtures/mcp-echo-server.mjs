#!/usr/bin/env node
/**
 * Minimal MCP server fixture for the harness MCP-client tests. Speaks
 * newline-delimited JSON-RPC 2.0 over stdio: initialize, tools/list, tools/call.
 * Tools: `echo` (returns its text) and `add` (returns a+b). `boom` reports an
 * MCP tool error (isError:true) to exercise the error path.
 */
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'boom',
    description: 'Always returns a tool error.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-fixture', version: '0.0.1' },
      },
    });
  } else if (msg.method === 'notifications/initialized') {
    /* notification — no reply */
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String((args.a ?? 0) + (args.b ?? 0)) }] } });
    } else if (name === 'boom') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'kaboom' }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
