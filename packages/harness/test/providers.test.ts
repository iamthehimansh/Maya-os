/**
 * Provider translation units — the internal message/tool format mapped into each
 * SDK's request shape. Pure functions, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSystem,
  mapStopReason,
  toAnthropicMessages,
  toAnthropicTools,
} from '../src/providers/anthropic.js';
import { toResponsesInput, toResponsesTools } from '../src/providers/openai.js';
import type { ModelMessage, ToolSpec } from '../src/types.js';

const CONVO: ModelMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'file body' }],
  },
];

const TOOLS: ToolSpec[] = [
  { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } },
  { name: 'bash', description: 'run a command', inputSchema: { type: 'object', properties: {} } },
];

describe('anthropic translation', () => {
  it('maps text / tool_call / tool_result blocks to SDK shapes', () => {
    const msgs = toAnthropicMessages(CONVO);
    expect(msgs).toHaveLength(3);
    // assistant tool_call → tool_use
    const asst = msgs[1]!.content as Array<Record<string, unknown>>;
    expect(asst[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } });
    // user tool_result → tool_result with tool_use_id
    const userRes = msgs[2]!.content as Array<Record<string, unknown>>;
    expect(userRes[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' });
  });

  it('flags is_error on failed tool results', () => {
    const msgs = toAnthropicMessages([
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c', content: 'boom', isError: true }] },
    ]);
    expect((msgs[0]!.content as Array<Record<string, unknown>>)[0]).toMatchObject({ is_error: true });
  });

  it('marks only the last tool ephemeral when caching', () => {
    const tools = toAnthropicTools(TOOLS, true);
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
    // no caching → no cache_control anywhere
    expect(toAnthropicTools(TOOLS, false)[1]!.cache_control).toBeUndefined();
  });

  it('prepends the Claude Code identity for OAuth and keeps a bare string otherwise', () => {
    const oauth = buildSystem('be helpful', true, false);
    expect(Array.isArray(oauth)).toBe(true);
    expect((oauth as Array<{ text: string }>)[0]!.text).toContain('You are Claude Code');
    expect((oauth as Array<{ text: string }>)[1]!.text).toBe('be helpful');
    // API key + no cache → plain string
    expect(buildSystem('be helpful', false, false)).toBe('be helpful');
    // undefined system + api → undefined
    expect(buildSystem(undefined, false, false)).toBeUndefined();
  });

  it('adds cache_control to the last system block when caching', () => {
    const sys = buildSystem('sys', false, true) as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[sys.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('maps stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('end_turn');
    expect(mapStopReason('tool_use')).toBe('tool_use');
    expect(mapStopReason('max_tokens')).toBe('max_tokens');
    expect(mapStopReason(null)).toBe('end_turn');
    expect(mapStopReason('refusal')).toBe('stop');
  });
});

describe('openai translation', () => {
  it('fans blocks out to Responses input items (function_call / function_call_output / messages)', () => {
    const input = toResponsesInput(CONVO) as Array<Record<string, unknown>>;
    // user "hi" → message; assistant text → message; assistant tool_call → function_call;
    // user tool_result → function_call_output
    const fnCall = input.find((i) => i['type'] === 'function_call');
    expect(fnCall).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'read' });
    expect(JSON.parse(fnCall!['arguments'] as string)).toEqual({ path: 'a.ts' });
    const fnOut = input.find((i) => i['type'] === 'function_call_output');
    expect(fnOut).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'file body' });
    // role messages carry string content
    const userMsg = input.find((i) => i['role'] === 'user');
    expect(userMsg).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('maps tools to flat function tools', () => {
    const tools = toResponsesTools(TOOLS);
    expect(tools[0]).toMatchObject({ type: 'function', name: 'read', strict: false });
    expect(tools[0]!.parameters).toEqual(TOOLS[0]!.inputSchema);
  });
});
