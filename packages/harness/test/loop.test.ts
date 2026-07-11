import { describe, it, expect } from 'vitest';
import { createSession } from '../src/loop/index.js';
import type {
  LoopEvent,
  PermissionGate,
  Provider,
  StreamEvent,
  StreamRequest,
  Tool,
  ToolResult,
} from '../src/types.js';

const allowAll: PermissionGate = { request: async () => true };

/** A scripted provider: each call to stream() plays the next scripted turn. */
function scriptedProvider(turns: StreamEvent[][]): Provider {
  let i = 0;
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(_req: StreamRequest): AsyncIterable<StreamEvent> {
      const turn = turns[i++] ?? [];
      for (const ev of turn) yield ev;
    },
  };
}

const echoTool: Tool = {
  spec: { name: 'echo', description: 'echo input', inputSchema: { type: 'object' } },
  async run(input: unknown): Promise<ToolResult> {
    return { content: `echoed:${JSON.stringify(input)}` };
  },
};

async function collect(session: ReturnType<typeof createSession>, prompt: string): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of session.run(prompt)) out.push(ev);
  return out;
}

function baseConfig(provider: Provider, tools: Tool[] = []) {
  return {
    provider,
    providerId: 'anthropic' as const,
    model: 'claude-opus-4-8',
    systemPrompt: 'test',
    tools,
    cwd: '/tmp',
    permission: allowAll,
    authMode: 'api' as const,
    authSource: 'test',
  };
}

describe('agent loop', () => {
  it('runs a tool call then finishes the turn', async () => {
    const provider = scriptedProvider([
      // turn 1: model asks to call echo
      [
        { type: 'text_delta', text: 'let me echo' },
        { type: 'tool_call', id: 't1', name: 'echo', input: { x: 1 } },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // turn 2: model responds with final text
      [
        { type: 'text_delta', text: 'done!' },
        { type: 'usage', usage: { inputTokens: 130, outputTokens: 5 } },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const session = createSession(baseConfig(provider, [echoTool]));
    const events = await collect(session, 'hi');

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types[types.length - 1]).toBe('turn_end');

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ id: 't1', output: 'echoed:{"x":1}', isError: false });

    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'turn_end', stopReason: 'end_turn' });

    // transcript: user, assistant(+toolcall), user(tool_result), assistant(text)
    expect(session.messages.length).toBe(4);
    // cumulative usage summed across both turns
    expect(session.state.usage.inputTokens).toBe(230);
    expect(session.state.usage.outputTokens).toBe(25);
    // opus pricing applied → non-zero cost
    expect(session.state.costUsd).toBeGreaterThan(0);
  });

  it('reports an unknown tool as an error result but keeps going', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call', id: 't1', name: 'nope', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const session = createSession(baseConfig(provider, [echoTool]));
    const events = await collect(session, 'hi');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ isError: true });
    expect(toolResult && 'output' in toolResult && toolResult.output).toContain('Unknown tool');
  });

  it('interrupts a running turn via AbortSignal — ends cleanly, no error event', async () => {
    // A provider that emits one delta then blocks until the request signal aborts.
    const provider: Provider = {
      id: 'anthropic',
      models: ['claude-opus-4-8'],
      async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
        yield { type: 'text_delta', text: 'thinking' };
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
          if (req.signal?.aborted) return onAbort();
          req.signal?.addEventListener('abort', onAbort);
        });
      },
    };
    const session = createSession(baseConfig(provider));
    const ac = new AbortController();
    const it = session.run('hi', { signal: ac.signal })[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.value).toMatchObject({ type: 'text_delta', text: 'thinking' });
    ac.abort();

    const rest: LoopEvent[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);

    expect(rest.some((e) => e.type === 'error')).toBe(false);
    expect(rest.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' });
  });

  it('loadMessages replaces the transcript (for /resume)', async () => {
    const provider = scriptedProvider([]);
    const session = createSession(baseConfig(provider));
    session.loadMessages([
      { role: 'user', content: [{ type: 'text', text: 'restored question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'restored answer' }] },
    ]);
    expect(session.messages.length).toBe(2);
    expect(session.messages[0]?.content[0]).toMatchObject({ type: 'text', text: 'restored question' });
  });

  it('clear() resets the transcript', async () => {
    const provider = scriptedProvider([
      [{ type: 'text_delta', text: 'hey' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const session = createSession(baseConfig(provider));
    await collect(session, 'hi');
    expect(session.messages.length).toBeGreaterThan(0);
    session.clear();
    expect(session.messages.length).toBe(0);
  });
});
