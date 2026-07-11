/**
 * Provider adapter STREAM tests (owner: @loop) — mock each SDK client and assert
 * the adapters normalize their native event streams into ONE ordered StreamEvent
 * stream, preserving true `text → tool → text → tool → text` model order for BOTH
 * providers (brief item #2), plus the Anthropic OAuth/subscription fixes (#3):
 *   - the client is built with the OAuth beta header (Bearer authToken, apiKey null),
 *   - reserved `mcp_` tool names are rewritten to a wire-safe `mcp-…` on the way
 *     out and the model's tool_call name is mapped back to the real name.
 *
 * The SDKs are mocked at the module boundary so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent, StreamRequest, Credential } from '../src/types.js';

// ── mock @anthropic-ai/sdk ────────────────────────────────────────────────────
let anthropicCtorOpts: any;
let anthropicStreamParams: any;
let anthropicEvents: any[] = [];
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages: { stream: (params: any, opts?: any) => AsyncIterable<any> };
    constructor(opts: any) {
      anthropicCtorOpts = opts;
      this.messages = {
        stream: (params: any) => {
          anthropicStreamParams = params;
          return (async function* () {
            for (const e of anthropicEvents) yield e;
          })();
        },
      };
    }
  }
  return { default: FakeAnthropic };
});

// ── mock openai ───────────────────────────────────────────────────────────────
let openaiCtorOpts: any;
let openaiCreateParams: any;
let openaiEvents: any[] = [];
vi.mock('openai', () => {
  class FakeOpenAI {
    responses: { create: (params: any, opts?: any) => Promise<AsyncIterable<any>> };
    constructor(opts: any) {
      openaiCtorOpts = opts;
      this.responses = {
        create: async (params: any) => {
          openaiCreateParams = params;
          return (async function* () {
            for (const e of openaiEvents) yield e;
          })();
        },
      };
    }
  }
  return { default: FakeOpenAI };
});

// Import AFTER the mocks are registered (vi.mock is hoisted, so this is safe).
import { createAnthropicProvider, oauthSafeToolName } from '../src/providers/anthropic.js';
import { createOpenAIProvider } from '../src/providers/openai.js';

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Reduce a StreamEvent list to a compact ordering signature. */
function shape(events: StreamEvent[]): string[] {
  return events
    .filter((e) => e.type === 'text_delta' || e.type === 'tool_call')
    .map((e) => (e.type === 'text_delta' ? `t:${e.text}` : `call:${e.name}`));
}

const OAUTH_CRED: Credential = {
  provider: 'anthropic',
  kind: 'oauth',
  source: 'test-keychain',
  token: 'sk-ant-oat-TESTTOKEN',
  headers: { 'anthropic-beta': 'oauth-2025-04-20' },
};
const API_CRED: Credential = {
  provider: 'anthropic',
  kind: 'api',
  source: 'env',
  token: 'sk-ant-api-KEY',
};

beforeEach(() => {
  anthropicCtorOpts = undefined;
  anthropicStreamParams = undefined;
  anthropicEvents = [];
  openaiCtorOpts = undefined;
  openaiCreateParams = undefined;
  openaiEvents = [];
});

// Anthropic raw stream-event builders (subset the adapter consumes).
const A = {
  start: () => ({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
  text: (index: number, text: string) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  }),
  toolStart: (index: number, id: string, name: string) => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name },
  }),
  toolJson: (index: number, partial_json: string) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json },
  }),
  stop: (index: number) => ({ type: 'content_block_stop', index }),
  end: (stop_reason: string) => ({
    type: 'message_delta',
    delta: { stop_reason },
    usage: { output_tokens: 7 },
  }),
};

describe('anthropic adapter — ordered interleaving (item #2)', () => {
  it('emits text → tool → text → tool → text in the exact model order', async () => {
    anthropicEvents = [
      A.start(),
      A.text(0, 'first '),
      A.text(0, 'thought'),
      A.toolStart(1, 't1', 'alpha'),
      A.toolJson(1, '{"n":1}'),
      A.stop(1),
      A.text(2, 'middle'),
      A.toolStart(3, 't2', 'beta'),
      A.toolJson(3, '{"n":2}'),
      A.stop(3),
      A.text(4, 'end'),
      A.end('end_turn'),
    ];
    const provider = createAnthropicProvider(API_CRED);
    const req: StreamRequest = {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [
        { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
        { name: 'beta', description: 'b', inputSchema: { type: 'object' } },
      ],
    };
    const events = await collect(provider.stream(req));
    expect(shape(events)).toEqual([
      't:first ',
      't:thought',
      'call:alpha',
      't:middle',
      'call:beta',
      't:end',
    ]);
    // The tool_call carries the fully-assembled input JSON.
    const alpha = events.find((e) => e.type === 'tool_call' && e.name === 'alpha');
    expect(alpha).toMatchObject({ input: { n: 1 } });
  });
});

describe('anthropic adapter — OAuth subscription fixes (item #3)', () => {
  it('builds the client with the OAuth beta header (Bearer authToken, apiKey null)', async () => {
    anthropicEvents = [A.start(), A.text(0, 'hi'), A.end('end_turn')];
    const provider = createAnthropicProvider(OAUTH_CRED);
    await collect(
      provider.stream({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
    expect(anthropicCtorOpts.authToken).toBe(OAUTH_CRED.token);
    expect(anthropicCtorOpts.apiKey).toBeNull();
    expect(anthropicCtorOpts.defaultHeaders['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('rewrites reserved `mcp_` tool names on the wire and restores them on tool_call', async () => {
    // The subscription endpoint 400s on any `mcp_` (single-underscore) tool name;
    // the adapter sends `mcp-connect` and the model returns that wire name.
    anthropicEvents = [
      A.start(),
      A.toolStart(0, 'x1', 'mcp-connect'),
      A.toolJson(0, '{"action":"list"}'),
      A.stop(0),
      A.end('tool_use'),
    ];
    const provider = createAnthropicProvider(OAUTH_CRED);
    const events = await collect(
      provider.stream({
        model: 'claude-opus-4-8',
        messages: [
          // A prior assistant tool_use with the real name must also be sanitized.
          { role: 'assistant', content: [{ type: 'tool_call', id: 'p0', name: 'mcp_connect', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', toolCallId: 'p0', content: 'ok' }] },
          { role: 'user', content: [{ type: 'text', text: 'connect' }] },
        ],
        tools: [
          { name: 'mcp_connect', description: 'connect an mcp server', inputSchema: { type: 'object' } },
          // Real MCP server tools use double-underscore and are EXEMPT — untouched.
          { name: 'mcp__github__search', description: 'search', inputSchema: { type: 'object' } },
        ],
      }),
    );
    // Wire: reserved name rewritten, double-underscore left alone.
    expect(anthropicStreamParams.tools.map((t: any) => t.name)).toEqual([
      'mcp-connect',
      'mcp__github__search',
    ]);
    // History tool_use block also rewritten to the wire-safe name.
    const asst = anthropicStreamParams.messages.find((m: any) => m.role === 'assistant');
    expect(asst.content[0].name).toBe('mcp-connect');
    // Model's tool_call comes back mapped to the REAL name for the loop's lookup.
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ name: 'mcp_connect', input: { action: 'list' } });
  });

  it('leaves `mcp_` names untouched on the API-key path', async () => {
    anthropicEvents = [A.start(), A.text(0, 'ok'), A.end('end_turn')];
    const provider = createAnthropicProvider(API_CRED);
    await collect(
      provider.stream({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'mcp_connect', description: 'x', inputSchema: { type: 'object' } }],
      }),
    );
    expect(anthropicStreamParams.tools[0].name).toBe('mcp_connect');
  });

  it('oauthSafeToolName rewrites single-underscore mcp_ but exempts mcp__ and others', () => {
    expect(oauthSafeToolName('mcp_connect')).toBe('mcp-connect');
    expect(oauthSafeToolName('mcp_server')).toBe('mcp-server');
    expect(oauthSafeToolName('mcp__github__search')).toBe('mcp__github__search');
    expect(oauthSafeToolName('mcpconnect')).toBe('mcpconnect');
    expect(oauthSafeToolName('read')).toBe('read');
  });
});

// OpenAI Responses stream-event builders (subset the adapter consumes).
const O = {
  text: (delta: string) => ({ type: 'response.output_text.delta', delta }),
  fn: (call_id: string, name: string, args: string) => ({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id, name, arguments: args },
  }),
  done: () => ({
    type: 'response.completed',
    response: { usage: { input_tokens: 10, output_tokens: 7 } },
  }),
};

describe('openai adapter — ordered interleaving (item #2)', () => {
  it('normalizes Responses deltas + function_call items into ordered text/tool events', async () => {
    openaiEvents = [
      O.text('first '),
      O.text('thought'),
      O.fn('c1', 'alpha', '{"n":1}'),
      O.text('middle'),
      O.fn('c2', 'beta', '{"n":2}'),
      O.text('end'),
      O.done(),
    ];
    const provider = createOpenAIProvider(API_CRED);
    const events = await collect(
      provider.stream({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        tools: [
          { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
          { name: 'beta', description: 'b', inputSchema: { type: 'object' } },
        ],
      }),
    );
    expect(shape(events)).toEqual([
      't:first ',
      't:thought',
      'call:alpha',
      't:middle',
      'call:beta',
      't:end',
    ]);
    const beta = events.find((e) => e.type === 'tool_call' && e.name === 'beta');
    expect(beta).toMatchObject({ input: { n: 2 } });
  });
});
