/**
 * @tui proof — the transcript renders arbitrarily interleaved assistant blocks
 * in the EXACT order the loop emits them: text → tool → text → tool → text.
 *
 * The loop (item 2) streams ordered LoopEvents (text_delta / tool_call /
 * tool_result); this test drives <App/> with a mocked session whose run() emits
 * the shape `[text, tool, text, tool, text]` across a multi-round turn and
 * asserts the rendered frame shows those blocks top-to-bottom in that order —
 * never "all text then all tools".
 */
import { describe, it, expect } from 'vitest';
import type { LoopEvent } from '../src/types.js';
import { renderApp, makeSession, delay } from './_app-harness.js';

/** A run that interleaves: text → tool → text → tool → text (2 tool rounds). */
async function* interleaved(): AsyncGenerator<LoopEvent> {
  yield { type: 'text_delta', text: 'INTRO thinking about the repo. ' };
  yield { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a.ts' } };
  yield { type: 'tool_result', id: 't1', output: 'file body', isError: false };
  yield { type: 'text_delta', text: 'MIDDLE now I list the dir. ' };
  yield { type: 'tool_call', id: 't2', name: 'list_dir', input: { path: '.' } };
  yield { type: 'tool_result', id: 't2', output: 'a.ts b.ts', isError: false };
  yield { type: 'text_delta', text: 'OUTRO all finished.' };
  yield { type: 'turn_end', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 3 }, costUsd: 0 };
}

describe('interleaved rendering (item 2)', () => {
  it('renders text → tool → text → tool → text in emit order', async () => {
    // A tall viewport so the whole interleaved transcript fits without scrolling.
    const { stdin, lastFrame } = renderApp(makeSession(interleaved), { rows: 60 });
    await delay();
    stdin.write('go');
    await delay(20);
    stdin.write('\r');
    await delay(150);

    const f = lastFrame()!;
    const iIntro = f.indexOf('INTRO');
    const iRead = f.indexOf('read_file');
    const iMiddle = f.indexOf('MIDDLE');
    const iList = f.indexOf('list_dir');
    const iOutro = f.indexOf('OUTRO');

    // Every block is present…
    expect(iIntro).toBeGreaterThanOrEqual(0);
    expect(iRead).toBeGreaterThanOrEqual(0);
    expect(iMiddle).toBeGreaterThanOrEqual(0);
    expect(iList).toBeGreaterThanOrEqual(0);
    expect(iOutro).toBeGreaterThanOrEqual(0);

    // …and they appear strictly in the emitted order, top-to-bottom.
    expect(iIntro).toBeLessThan(iRead);
    expect(iRead).toBeLessThan(iMiddle);
    expect(iMiddle).toBeLessThan(iList);
    expect(iList).toBeLessThan(iOutro);
  });
});
