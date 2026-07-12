/**
 * Mid-turn steering: a message submitted WHILE a turn is in flight reaches the
 * model at the next tool-result boundary — not after the turn ends.
 *
 * Every test here injects from inside a tool's `run()`, which is the real timing
 * we care about: the agent is N tool-calls deep and the user types "no, stop, do
 * X instead". The steer must land before the model picks its next step.
 *
 * The provider shapes are asserted against the REAL adapters (toAnthropicMessages
 * / toResponsesInput), not a stub — a steer that produces a transcript the API
 * would reject is the whole failure mode this feature has to avoid.
 */
import { describe, it, expect } from 'vitest';
import { createSession } from '../src/loop/index.js';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import { toResponsesInput } from '../src/providers/openai.js';
import type {
  LoopEvent,
  PermissionGate,
  Provider,
  Session,
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

/** A tool that runs `during()` while it executes — i.e. mid-turn, mid-tool. */
function tool(name: string, during?: () => void): Tool {
  return {
    spec: { name, description: name, inputSchema: { type: 'object' } },
    async run(): Promise<ToolResult> {
      during?.();
      return { content: `${name}-output` };
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

/** One tool call, then a closing text turn. */
function oneToolThenDone(toolName = 'alpha'): StreamEvent[][] {
  return [
    [
      { type: 'text_delta', text: 'working…' },
      { type: 'tool_call', id: 'call_1', name: toolName, input: {} },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [{ type: 'text_delta', text: 'ok, doing X instead' }, { type: 'done', stopReason: 'end_turn' }],
  ];
}

/** The user message that carries the tool results (the injection boundary). */
function toolResultMessage(session: Session) {
  return session.messages.find((m) => m.content.some((b) => b.type === 'tool_result'))!;
}

describe('mid-turn steering — Anthropic shape', () => {
  it('lands as a text block AFTER the tool_result blocks in the SAME user message', async () => {
    const provider = scriptedProvider(oneToolThenDone());
    let session!: Session;
    session = createSession(
      baseConfig(provider, {
        // The user types while the tool is running.
        tools: [tool('alpha', () => session.inject('no, stop — do X instead'))],
      }),
    );

    await collect(session.run('do the thing'));

    // ── the boundary message ──
    const boundary = toolResultMessage(session);
    expect(boundary.role).toBe('user');
    expect(boundary.content.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(boundary.content[1]).toMatchObject({ type: 'text', text: 'no, stop — do X instead' });

    // ── it is NOT a bare extra user message (that would break tool pairing) ──
    const userMsgs = session.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2); // the original prompt + the tool-result/steer message

    // ── the real adapter emits an API-valid transcript: every tool_use is answered
    //    by a tool_result in the IMMEDIATELY following user message, and the steer
    //    rides in that same message rather than displacing the pairing.
    const wire = toAnthropicMessages(session.messages);
    const assistantIdx = wire.findIndex(
      (m) => Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === 'tool_use'),
    );
    const next = wire[assistantIdx + 1]!;
    expect(next.role).toBe('user');
    const blocks = next.content as { type: string; tool_use_id?: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(blocks[0]!.tool_use_id).toBe('call_1'); // pairing intact
    expect(blocks[1]!.text).toBe('no, stop — do X instead');
  });

  it('the model sees the steer on its very next request — before it takes another step', async () => {
    const seen: StreamRequest[] = [];
    const provider = scriptedProvider(oneToolThenDone(), (r) => seen.push({ ...r, messages: [...r.messages] }));
    let session!: Session;
    session = createSession(
      baseConfig(provider, { tools: [tool('alpha', () => session.inject('actually, do X'))] }),
    );
    await collect(session.run('do the thing'));

    // Request 2 is the model's next step after the tool ran. The steer must already
    // be in its context — that is the entire point of the feature.
    expect(seen).toHaveLength(2);
    const texts = seen[1]!.messages.flatMap((m) =>
      m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
    );
    expect(texts).toContain('actually, do X');
  });

  it('emits an `injected` event at the injection point, tagged at:"tool_result"', async () => {
    const provider = scriptedProvider(oneToolThenDone());
    let session!: Session;
    session = createSession(
      baseConfig(provider, { tools: [tool('alpha', () => session.inject('steer me'))] }),
    );
    const events = await collect(session.run('go'));

    const shape = events
      .filter((e) => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'injected')
      .map((e) => e.type);
    // The steer is announced right after the tool result it rode in with, so the
    // TUI can render it inline exactly where the model received it.
    expect(shape).toEqual(['tool_call', 'tool_result', 'injected']);
    expect(events.find((e) => e.type === 'injected')).toEqual({
      type: 'injected',
      text: 'steer me',
      at: 'tool_result',
    });
  });
});

describe('mid-turn steering — OpenAI shape', () => {
  it('becomes a user message right after the tool-result (function_call_output) items', async () => {
    const provider = scriptedProvider(oneToolThenDone());
    let session!: Session;
    session = createSession(
      baseConfig(provider, { tools: [tool('alpha', () => session.inject('do X instead'))] }),
    );
    await collect(session.run('do the thing'));

    // The OpenAI adapter fans the one boundary message out into: the tool-result
    // item(s), then a user message carrying the steer — in that order.
    const items = toResponsesInput(session.messages) as Record<string, unknown>[];
    const outIdx = items.findIndex((it) => it.type === 'function_call_output');
    expect(outIdx).toBeGreaterThanOrEqual(0);
    expect(items[outIdx]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });

    const after = items[outIdx + 1]!;
    expect(after).toMatchObject({ role: 'user', content: 'do X instead' });

    // The function_call that the output answers still precedes it (pairing intact).
    const callIdx = items.findIndex((it) => it.type === 'function_call');
    expect(callIdx).toBeLessThan(outIdx);
    expect(items[callIdx]).toMatchObject({ call_id: 'call_1' });
  });
});

describe('mid-turn steering — queue semantics', () => {
  it('flushes ALL queued messages, in order, at the next boundary', async () => {
    const provider = scriptedProvider(oneToolThenDone());
    let session!: Session;
    session = createSession(
      baseConfig(provider, {
        tools: [
          tool('alpha', () => {
            // Three messages typed while the one tool was running.
            expect(session.inject('first')).toBe(1);
            expect(session.inject('second')).toBe(2);
            expect(session.inject('third')).toBe(3);
            expect(session.pendingInjections).toBe(3);
          }),
        ],
      }),
    );
    const events = await collect(session.run('go'));

    const boundary = toolResultMessage(session);
    expect(boundary.content.map((b) => b.type)).toEqual(['tool_result', 'text', 'text', 'text']);
    expect(boundary.content.slice(1).map((b) => (b as { text: string }).text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    // One event per message, in order — so the TUI retires one steering chip each.
    expect(events.filter((e) => e.type === 'injected').map((e) => (e as { text: string }).text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(session.pendingInjections).toBe(0);
  });

  it('carries image attachments in the same message as the tool results', async () => {
    const provider = scriptedProvider(oneToolThenDone());
    let session!: Session;
    session = createSession(
      baseConfig(provider, {
        tools: [
          tool('alpha', () =>
            session.inject([
              { type: 'text', text: 'look at this' },
              { type: 'image', mediaType: 'image/png', data: 'AAAA' },
            ]),
          ),
        ],
      }),
    );
    await collect(session.run('go'));

    const boundary = toolResultMessage(session);
    expect(boundary.content.map((b) => b.type)).toEqual(['tool_result', 'text', 'image']);
    expect(boundary.content[2]).toMatchObject({ type: 'image', mediaType: 'image/png', data: 'AAAA' });
  });

  it('a steer typed when NO further tool calls come is still delivered — as the next user turn', async () => {
    // The model streams its final text and stops calling tools, so there is no
    // tool-result boundary left. Rule: never drop it. It becomes a fresh user turn
    // and the loop keeps going, so it actually gets answered.
    const provider = scriptedProvider([
      [{ type: 'text_delta', text: 'all done' }, { type: 'done', stopReason: 'end_turn' }],
      [{ type: 'text_delta', text: 'oh — one more thing then' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const session = createSession(baseConfig(provider));

    // Queue it after the run has been constructed but before it is consumed — the
    // scripted turn has no tools, so this is the "turn is ending" race.
    const iter = session.run('go')[Symbol.asyncIterator]();
    const first = await iter.next(); // pull the first event; the turn is now in flight
    expect(first.value).toMatchObject({ type: 'text_delta' });
    session.inject('wait — also check the logs');

    const rest: LoopEvent[] = [];
    for (let n = await iter.next(); !n.done; n = await iter.next()) rest.push(n.value);

    // Delivered as its own user turn…
    const injected = rest.find((e) => e.type === 'injected');
    expect(injected).toEqual({ type: 'injected', text: 'wait — also check the logs', at: 'new_turn' });
    const lastUser = [...session.messages].reverse().find((m) => m.role === 'user')!;
    expect(lastUser.content).toEqual([{ type: 'text', text: 'wait — also check the logs' }]);
    // …and answered, rather than sitting in the queue until the next run().
    expect(rest.some((e) => e.type === 'text_delta' && e.text === 'oh — one more thing then')).toBe(true);
    expect(session.pendingInjections).toBe(0);
    expect(rest.at(-1)).toMatchObject({ type: 'turn_end' });
  });
});

describe('mid-turn steering — interrupt still wins', () => {
  it('Esc aborts cleanly, and a steer queued into the aborted turn is not dropped', async () => {
    const ac = new AbortController();
    const provider = scriptedProvider([
      [
        { type: 'tool_call', id: 'call_1', name: 'alpha', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // If the loop wrongly continued after the abort, it would consume this turn.
      [{ type: 'text_delta', text: 'SHOULD NOT RUN' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    let session!: Session;
    session = createSession(
      baseConfig(provider, {
        tools: [
          tool('alpha', () => {
            // The user steers and THEN hits Esc — the abort takes priority.
            session.inject('steer that got interrupted');
            ac.abort();
          }),
        ],
      }),
    );

    const events = await collect(session.run('go', { signal: ac.signal }));

    // Aborted cleanly: turn_end with stopReason 'stop', no error event.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' });
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'SHOULD NOT RUN')).toBe(false);

    // The steer did NOT ride into the aborted turn's tool-result message…
    const boundary = toolResultMessage(session);
    expect(boundary.content.map((b) => b.type)).toEqual(['tool_result']);
    expect(events.some((e) => e.type === 'injected')).toBe(false);

    // …it is still queued, and lands at the head of the next run. Nothing dropped.
    expect(session.pendingInjections).toBe(1);
    const next = await collect(session.run('ok, continue'));
    expect(next.find((e) => e.type === 'injected')).toEqual({
      type: 'injected',
      text: 'steer that got interrupted',
      at: 'turn_start',
    });
    const userTexts = session.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    // It rides AHEAD of the new user input — hence at:'turn_start' for the TUI.
    expect(userTexts.slice(-2)).toEqual(['steer that got interrupted', 'ok, continue']);
    expect(session.pendingInjections).toBe(0);
  });

  it('abort-then-redirect: run() with no input delivers the interrupted steer and answers it', async () => {
    // "stop — do X instead" is the most common steer there is: type, hit Esc, and
    // the message you typed should RUN, not sit in the queue until you type again.
    // The TUI drives this by re-running with no new user text once the abort lands.
    const ac = new AbortController();
    const provider = scriptedProvider([
      [
        { type: 'tool_call', id: 'call_1', name: 'alpha', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'doing X instead' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    let session!: Session;
    session = createSession(
      baseConfig(provider, {
        tools: [
          tool('alpha', () => {
            session.inject('stop — do X instead');
            ac.abort();
          }),
        ],
      }),
    );

    const aborted = await collect(session.run('do the thing', { signal: ac.signal }));
    expect(aborted.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' });
    expect(session.pendingInjections).toBe(1);

    // No new user text — just flush what's queued and let the model answer it.
    const events = await collect(session.run());
    expect(events.find((e) => e.type === 'injected')).toEqual({
      type: 'injected',
      text: 'stop — do X instead',
      at: 'turn_start',
    });
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'doing X instead')).toBe(true);
    expect(session.pendingInjections).toBe(0);

    // The steer became a real user message — no empty user message was sent.
    const users = session.messages.filter((m) => m.role === 'user');
    expect(users.every((m) => m.content.length > 0)).toBe(true);
    expect(users.at(-1)!.content).toEqual([{ type: 'text', text: 'stop — do X instead' }]);
  });

  it('a blank steer is dropped, never queued as an empty user message', async () => {
    // An empty user message is rejected by the API, so a blank submit must not
    // become one — at any of the three flush points.
    const provider = scriptedProvider(oneToolThenDone());
    let session!: Session;
    session = createSession(
      baseConfig(provider, {
        tools: [
          tool('alpha', () => {
            expect(session.inject('')).toBe(0);
            expect(session.inject([])).toBe(0);
            expect(session.pendingInjections).toBe(0);
          }),
        ],
      }),
    );
    const events = await collect(session.run('go'));

    expect(events.some((e) => e.type === 'injected')).toBe(false);
    expect(toolResultMessage(session).content.map((b) => b.type)).toEqual(['tool_result']);
    expect(session.messages.every((m) => m.content.length > 0)).toBe(true);
  });

  it('run() with nothing queued and no input is a clean no-op', async () => {
    const provider = scriptedProvider([
      [{ type: 'text_delta', text: 'SHOULD NOT STREAM' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const session = createSession(baseConfig(provider));
    const events = await collect(session.run());
    expect(events).toEqual([
      { type: 'turn_end', stopReason: 'end_turn', usage: session.state.usage, costUsd: session.costUsd },
    ]);
    expect(session.messages).toHaveLength(0); // no empty user message pushed
  });
});
