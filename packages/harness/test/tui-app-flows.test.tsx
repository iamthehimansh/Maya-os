import { describe, it, expect } from 'vitest';
import type { LoopEvent, ModelMessage, SessionRecord } from '../src/types.js';
import { renderApp, makeSession, makeStore, delay, KEY } from './_app-harness.js';

const usage = { inputTokens: 1, outputTokens: 1 };

async function typeSeq(stdin: { write(s: string): void }, seqs: string[], each = 20): Promise<void> {
  for (const s of seqs) {
    stdin.write(s);
    await delay(each);
  }
}

describe('send-while-working queue + Esc interrupt', () => {
  // First turn hangs until the signal aborts; subsequent turns reply quickly.
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

  it('steers a message typed mid-turn, Esc interrupts, then the pending message runs', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(run), { rows: 30 });
    await delay();

    // Start a long turn.
    await typeSeq(stdin, ['first', KEY.enter]);
    await delay(40);
    expect(lastFrame()).toContain('working…');

    // Type another message while busy → it goes to the session as a steer (chip
    // shown). This turn calls no tools, so it has no boundary to land on yet.
    await typeSeq(stdin, ['second', KEY.enter]);
    await delay(40);
    expect(lastFrame()).toContain('⚡ steering');
    expect(lastFrame()).toContain('second');
    expect(lastFrame()).not.toContain('reply to second');

    // Esc interrupts the running turn. The pending message is not work — it
    // survives the abort and runs, exactly as it did before steering existed.
    stdin.write(KEY.esc);
    await delay(200);
    const f = lastFrame()!;
    expect(f).toContain('interrupted.');
    expect(f).toContain('reply to second');
  });
});

describe('/resume reloads a stored session', () => {
  it('reconstructs the transcript from the stored messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'previous question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
    ];
    const rec: SessionRecord = { id: 's1', createdAt: 0, updatedAt: 1, provider: 'anthropic', model: 'claude-opus-4-8', cwd: '/repo', messages };
    const store = makeStore([rec]);

    async function* end(): AsyncGenerator<LoopEvent> {
      yield { type: 'turn_end', stopReason: 'end_turn', usage, costUsd: 0 };
    }
    const { stdin, lastFrame } = renderApp(makeSession(end), { store, rows: 24 });
    await delay();

    await typeSeq(stdin, ['/resume s1', KEY.enter], 30);
    await delay(60);
    const f = lastFrame()!;
    expect(f).toContain('resumed session s1');
    expect(f).toContain('previous question');
    expect(f).toContain('previous answer');
  });
});
