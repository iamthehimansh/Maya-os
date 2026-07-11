/**
 * @core proof tests for the shared contracts:
 *   1. Interleaved text → tool → text → tool ordering (item 1), preserved in both
 *      the live LoopEvent stream AND the persisted assistant blocks.
 *   2. Dynamic tool registry — tools registered AFTER session creation are used.
 *   3. Context hook — assembleSystem()/assembleContext() are called by the loop.
 *   4. inject() (cron wake) + run(ContentBlock[]) with an image attachment.
 */
import { describe, it, expect } from 'vitest';
import { createSession } from '../src/loop/index.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type {
  ContextManager,
  LoopEvent,
  ModelMessage,
  PermissionGate,
  Provider,
  StreamEvent,
  StreamRequest,
  Tool,
  ToolResult,
} from '../src/types.js';

const allowAll: PermissionGate = { request: async () => true };

function scriptedProvider(turns: StreamEvent[][], onReq?: (r: StreamRequest) => void): Provider {
  let i = 0;
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      onReq?.(req);
      const turn = turns[i++] ?? [];
      for (const ev of turn) yield ev;
    },
  };
}

function tool(name: string): Tool {
  return {
    spec: { name, description: name, inputSchema: { type: 'object' } },
    async run(input: unknown): Promise<ToolResult> {
      return { content: `${name}:${JSON.stringify(input)}` };
    },
  };
}

function baseConfig(provider: Provider, extra: Record<string, unknown> = {}) {
  return {
    provider,
    providerId: 'anthropic' as const,
    model: 'claude-opus-4-8',
    systemPrompt: 'test',
    tools: [] as Tool[],
    cwd: '/tmp',
    permission: allowAll,
    authMode: 'api' as const,
    authSource: 'test',
    ...extra,
  };
}

async function collect(iter: AsyncIterable<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('interleaved text/tool ordering (item 1)', () => {
  it('preserves text → tool → text → tool in the event stream AND the transcript', async () => {
    const provider = scriptedProvider([
      // turn 1: the model interleaves text and two tool calls
      [
        { type: 'text_delta', text: 'first ' },
        { type: 'text_delta', text: 'thought' },
        { type: 'tool_call', id: 'a1', name: 'alpha', input: { n: 1 } },
        { type: 'text_delta', text: 'middle thought' },
        { type: 'tool_call', id: 'b2', name: 'beta', input: { n: 2 } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // turn 2: final text
      [
        { type: 'text_delta', text: 'all done' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const session = createSession(baseConfig(provider, { tools: [tool('alpha'), tool('beta')] }));
    const events = await collect(session.run('go'));

    // Live stream: the tool_call events land BETWEEN the text they were emitted
    // between — not buffered to the end. Filter to the ordering-relevant events.
    const shape = events
      .filter((e) => e.type === 'text_delta' || e.type === 'tool_call' || e.type === 'tool_result')
      .map((e) =>
        e.type === 'text_delta'
          ? `t:${e.text}`
          : e.type === 'tool_call'
            ? `call:${e.name}`
            : `res:${e.id}`,
      );
    expect(shape).toEqual([
      't:first ',
      't:thought',
      'call:alpha', // ← comes AFTER the first text, BEFORE the middle text
      't:middle thought',
      'call:beta',
      // results follow the interleaved calls, keyed by id
      'res:a1',
      'res:b2',
      't:all done',
    ]);

    // Persisted assistant blocks keep the same order → /resume replays interleaving.
    const assistant = session.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content.map((b) => b.type)).toEqual([
      'text', // "first thought"
      'tool_call', // alpha
      'text', // "middle thought"
      'tool_call', // beta
    ]);
    expect(assistant.content[0]).toMatchObject({ type: 'text', text: 'first thought' });
    expect(assistant.content[1]).toMatchObject({ type: 'tool_call', name: 'alpha' });
    expect(assistant.content[2]).toMatchObject({ type: 'text', text: 'middle thought' });
    expect(assistant.content[3]).toMatchObject({ type: 'tool_call', name: 'beta' });
  });

  it('handles the full [text,tool,text,tool,text, text,tool,tool] shape across 2 rounds', async () => {
    // Brief item #2: an arbitrary multi-round turn — text between/around tools,
    // then consecutive text (round boundary) and consecutive tools. The emitted
    // block order must match exactly, with every tool round run in between.
    const provider = scriptedProvider([
      // round 1: text → tool → text → tool → text  (ends on tool_use → loop continues)
      [
        { type: 'text_delta', text: 'r1a' },
        { type: 'tool_call', id: 'c1', name: 'alpha', input: {} },
        { type: 'text_delta', text: 'r1b' },
        { type: 'tool_call', id: 'c2', name: 'beta', input: {} },
        { type: 'text_delta', text: 'r1c' },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // round 2: text → tool → tool  (consecutive tools; ends on tool_use)
      [
        { type: 'text_delta', text: 'r2a' },
        { type: 'tool_call', id: 'c3', name: 'alpha', input: {} },
        { type: 'tool_call', id: 'c4', name: 'beta', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // round 3: closing text
      [{ type: 'text_delta', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const session = createSession(baseConfig(provider, { tools: [tool('alpha'), tool('beta')] }));
    const events = await collect(session.run('go'));

    // The live text/tool stream matches the concatenated block order verbatim.
    const stream = events
      .filter((e) => e.type === 'text_delta' || e.type === 'tool_call')
      .map((e) => (e.type === 'text_delta' ? `t:${e.text}` : `call:${e.name}`));
    expect(stream).toEqual([
      't:r1a',
      'call:alpha',
      't:r1b',
      'call:beta',
      't:r1c',
      't:r2a', // consecutive text across the round boundary
      'call:alpha',
      'call:beta', // consecutive tools in one round
      't:done',
    ]);
    // Every tool round actually ran (4 results, in call order).
    const results = events.filter((e) => e.type === 'tool_result').map((e) => (e as { id: string }).id);
    expect(results).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});

describe('dynamic tool registry (contract 2)', () => {
  it('uses a tool registered AFTER the session was created', async () => {
    const registry = createToolRegistry();
    const provider = scriptedProvider(
      [
        [
          { type: 'tool_call', id: 'l1', name: 'late', input: { ok: true } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }],
      ],
      // The request's tool list must reflect the late registration.
      (req) => {
        if (req.messages.length === 1) expect(req.tools?.map((t) => t.name)).toContain('late');
      },
    );
    const session = createSession(baseConfig(provider, { registry }));
    // Register only NOW — after createSession.
    registry.register(tool('late'));
    const events = await collect(session.run('use the late tool'));
    const res = events.find((e) => e.type === 'tool_result');
    expect(res).toMatchObject({ id: 'l1', output: 'late:{"ok":true}', isError: false });
  });
});

// Finding #1 (sub-agent sees late-registered MCP tools via subAgentRegistry) is
// covered end-to-end by @tools' test/sub-agent-live-tools.test.ts + @agents'
// subAgentRegistry unit test — not duplicated here.

describe('context hook (contract 3)', () => {
  it('assembleSystem() drives the request system and assembleContext() runs per turn', async () => {
    let systemSeen: string | undefined;
    const provider = scriptedProvider(
      [[{ type: 'text_delta', text: 'hi' }, { type: 'done', stopReason: 'end_turn' }]],
      (req) => {
        systemSeen = req.system;
      },
    );
    let contextCalls = 0;
    const context: ContextManager = {
      assembleSystem: () => 'ASSEMBLED SYSTEM + memory',
      async assembleContext(messages) {
        contextCalls++;
        return { messages: [...messages] };
      },
      estimateTokens: () => 0,
    };
    const session = createSession(baseConfig(provider, { context }));
    await collect(session.run('yo'));
    expect(systemSeen).toBe('ASSEMBLED SYSTEM + memory');
    expect(contextCalls).toBeGreaterThan(0);
  });

  it('compact() forces a compaction and reports before/after', async () => {
    const provider = scriptedProvider([]);
    const context: ContextManager = {
      assembleSystem: () => 'sys',
      async assembleContext(messages, opts) {
        if (opts.force) {
          const summary = await opts.summarize('long transcript');
          return {
            messages: [{ role: 'user', content: [{ type: 'text', text: summary }] }] as ModelMessage[],
            compacted: { before: 1000, after: 100 },
          };
        }
        return { messages: [...messages] };
      },
      estimateTokens: () => 0,
    };
    const session = createSession(baseConfig(provider, { context }));
    const res = await session.compact();
    expect(res).toEqual({ before: 1000, after: 100 });
  });
});

describe('run inputs (contract: string | ContentBlock[]) + inject()', () => {
  it('accepts an image attachment block in the user turn', async () => {
    let seen: ModelMessage[] | undefined;
    const provider = scriptedProvider(
      [[{ type: 'text_delta', text: 'nice png' }, { type: 'done', stopReason: 'end_turn' }]],
      (req) => {
        seen = [...req.messages];
      },
    );
    const session = createSession(baseConfig(provider));
    await collect(
      session.run([
        { type: 'text', text: 'what is this?' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ]),
    );
    const user = seen!.find((m) => m.role === 'user')!;
    expect(user.content.map((b) => b.type)).toEqual(['text', 'image']);
    expect(user.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png', data: 'AAAA' });
  });

  it('inject() delivers a queued wake message ahead of the next run()', async () => {
    const provider = scriptedProvider([
      [{ type: 'text_delta', text: 'woke up' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const session = createSession(baseConfig(provider));
    expect(session.inject('⏰ scheduled: check the build')).toBe(1);
    await collect(session.run('and here is my prompt'));
    const userTexts = session.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    // The injected wake precedes the real user prompt.
    expect(userTexts).toEqual(['⏰ scheduled: check the build', 'and here is my prompt']);
  });
});
