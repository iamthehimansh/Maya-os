/**
 * Mid-turn steering, from the TUI's side of the contract.
 *
 * A message typed while the agent is working is not a queued turn — it is handed
 * to `session.inject()` and reaches the model at its next tool-result boundary.
 * These tests drive the real event stream the loop emits (`injected` with its
 * `at` boundary) and assert what the reader actually sees: where the steer lands
 * in the transcript relative to the tool calls, and whether the chip still says
 * it is in flight.
 */
import { describe, it, expect } from 'vitest';
import type { LoopEvent } from '../src/types.js';
import { renderApp, makeSession, delay, KEY, type InjectCtx } from './_app-harness.js';

const usage = { inputTokens: 1, outputTokens: 1 };

async function typeSeq(stdin: { write(s: string): void }, seqs: string[], each = 20): Promise<void> {
  for (const s of seqs) {
    stdin.write(s);
    await delay(each);
  }
}

/** Where each needle appears in the frame — the whole point is the ORDER. */
function order(frame: string, ...needles: string[]): number[] {
  return needles.map((n) => {
    const i = frame.indexOf(n);
    expect(i, `expected the frame to contain ${JSON.stringify(n)}`).toBeGreaterThanOrEqual(0);
    return i;
  });
}

/**
 * A turn that calls a tool, waits (as a real tool would), then flushes whatever
 * was steered in at that tool-result boundary and keeps going. This is the shape
 * the loop produces; the App must render it in stream order.
 */
function toolTurn(): (t: string, s: AbortSignal | undefined, i: number, inj: InjectCtx) => AsyncGenerator<LoopEvent> {
  return async function* (_text, signal, _i, inj) {
    yield { type: 'text_delta', text: 'reading the file' };
    yield { type: 'tool_call', id: 't1', name: 'Read', input: { path: 'a.ts' } };
    // Stand in for a slow tool: hold the turn open until a steer arrives, then
    // keep working a moment longer — a real tool doesn't stop the instant you
    // type, so the steer is genuinely observable as "in flight" before it lands.
    for (let n = 0; n < 60 && inj.count() === 0 && !signal?.aborted; n++) await delay(10);
    for (let n = 0; n < 12 && !signal?.aborted; n++) await delay(10);
    yield { type: 'tool_result', id: 't1', output: 'file contents' };
    // The boundary: everything queued lands here, in the same user message as
    // the tool results above.
    yield* inj.take('tool_result');
    yield { type: 'text_delta', text: 'switching approach' };
    yield { type: 'turn_end', stopReason: 'end_turn', usage, costUsd: 0 };
  };
}

describe('mid-turn steering', () => {
  it('renders the steer inline at the point it landed — after the tool it interrupted, before what followed', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(toolTurn()), { rows: 30 });
    await delay();

    await typeSeq(stdin, ['do the thing', KEY.enter]);
    await delay(40);
    // The turn is in flight and has already called its tool.
    expect(lastFrame()).toContain('reading the file');

    await typeSeq(stdin, ['no, use b.ts', KEY.enter]);
    await delay(200);

    const f = lastFrame()!;
    // The steer is a real user message in the transcript, sitting exactly where
    // it reached the model: after the tool call it landed behind, and before the
    // text the model produced in response to it.
    const [tool, steer, after] = order(f, 'Read', '› no, use b.ts', 'switching approach');
    expect(tool).toBeLessThan(steer!);
    expect(steer!).toBeLessThan(after!);
  });

  it('chip reads as steering while in flight, and clears once the message reaches the model', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(toolTurn()), { rows: 30 });
    await delay();

    await typeSeq(stdin, ['do the thing', KEY.enter]);
    await delay(40);
    await typeSeq(stdin, ['actually use b.ts', KEY.enter]);
    await delay(30);

    // In flight: the chip says it is steering, not that it is waiting for the turn.
    const mid = lastFrame()!;
    expect(mid).toContain('⚡ steering');
    expect(mid).toContain('actually use b.ts');
    expect(mid).not.toContain('queued');
    // It has NOT yet reached the model, so it is not in the transcript.
    expect(mid).not.toContain('› actually use b.ts');

    await delay(220);
    // Landed: chip gone, message now in the transcript.
    const done = lastFrame()!;
    expect(done).not.toContain('⚡ steering');
    expect(done).toContain('› actually use b.ts');
  });

  it('lands several steers at one boundary, in the order they were typed', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(toolTurn()), { rows: 30 });
    await delay();

    await typeSeq(stdin, ['do the thing', KEY.enter]);
    await delay(40);
    await typeSeq(stdin, ['first steer', KEY.enter]);
    await typeSeq(stdin, ['second steer', KEY.enter]);
    await delay(30);
    // Both are in flight, both shown.
    expect(lastFrame()).toContain('first steer');
    expect(lastFrame()).toContain('second steer');

    await delay(220);
    const f = lastFrame()!;
    // Both landed, neither dropped, and FIFO order preserved in the transcript.
    const [one, two] = order(f, '› first steer', '› second steer');
    expect(one).toBeLessThan(two!);
    expect(f).not.toContain('⚡ steering');
  });

  it('keeps the input live during a turn — typing echoes while the agent works', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(toolTurn()), { rows: 30 });
    await delay();

    await typeSeq(stdin, ['do the thing', KEY.enter]);
    await delay(40);
    expect(lastFrame()).toContain('working…');

    // Half-typed, mid-turn: the characters are on screen and the hint invites a steer.
    await typeSeq(stdin, ['half typed']);
    const f = lastFrame()!;
    expect(f).toContain('half typed');
    expect(f).toContain('type to steer');
  });
});

describe('steering vs. Esc', () => {
  // Turn 0 hangs until aborted (and never reaches a tool boundary); later turns reply.
  async function* run(text: string, signal: AbortSignal | undefined, i: number): AsyncGenerator<LoopEvent> {
    if (i === 0) {
      yield { type: 'text_delta', text: 'working…' };
      while (!signal?.aborted) await delay(10);
      yield { type: 'turn_end', stopReason: 'stop', usage, costUsd: 0 };
    } else {
      yield { type: 'text_delta', text: `reply to ${text}` };
      yield { type: 'turn_end', stopReason: 'end_turn', usage, costUsd: 0 };
    }
  }

  it('Esc still aborts, and a steer that never reached a boundary is run rather than stranded', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(run), { rows: 30 });
    await delay();

    await typeSeq(stdin, ['first', KEY.enter]);
    await delay(40);
    expect(lastFrame()).toContain('working…');

    // Typed mid-turn, but this turn calls no tools — it never gets a boundary.
    await typeSeq(stdin, ['second', KEY.enter]);
    await delay(40);
    expect(lastFrame()).toContain('⚡ steering');
    expect(lastFrame()).not.toContain('reply to second');

    // Esc aborts the work. The message is not work — it survives and runs, so
    // "stop, do this instead" still gets answered without retyping.
    stdin.write(KEY.esc);
    await delay(200);
    const f = lastFrame()!;
    expect(f).toContain('interrupted.');
    expect(f).toContain('reply to second');
    expect(f).not.toContain('⚡ steering');
  });

  it('an injection queued while idle renders AHEAD of the user message that follows it', async () => {
    // The `turn_start` case: a cron/`/schedule` wake lands while nothing is
    // running, then the user types. The loop flushes the wake ahead of that input
    // in `messages` — so the transcript must show it ahead too, even though the
    // TUI echoed the user's own message the moment they hit enter. Getting this
    // wrong inverts the transcript against what the model actually saw.
    const session = makeSession(run);
    const { stdin, lastFrame } = renderApp(session, { rows: 30 });
    await delay();

    session.inject('cron wake: build finished');
    await typeSeq(stdin, ['what happened?', KEY.enter]);
    await delay(200);

    const f = lastFrame()!;
    const [wake, mine] = order(f, '› cron wake: build finished', '› what happened?');
    expect(wake).toBeLessThan(mine!);
  });
});
