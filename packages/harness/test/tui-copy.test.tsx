/**
 * Select-to-copy: copy mode, the focused-tool copy, `/copy`, and the OSC 52 /
 * pbcopy sink. The clipboard is mocked everywhere — no test touches the real one.
 */
import { describe, it, expect } from 'vitest';
import type { LoopEvent } from '../src/types.js';
import { createClipboard, osc52, type ClipboardResult } from '../src/tui/clipboard.js';
import {
  copyRange,
  enterCopy,
  lastAssistantText,
  linesToText,
  moveCopy,
  revealRow,
  selectAll,
  toggleAnchor,
  toolBlockText,
  transcriptText,
} from '../src/tui/copy.js';
import type { Entry } from '../src/tui/entries.js';
import type { Line } from '../src/tui/lines.js';
import { renderApp, makeSession, endTurn, delay, KEY } from './_app-harness.js';

async function typeSeq(stdin: { write(s: string): void }, seqs: string[], each = 20): Promise<void> {
  for (const s of seqs) {
    stdin.write(s);
    await delay(each);
  }
}

/** A clipboard sink that records payloads instead of writing anywhere. */
function fakeClipboard(ok = true) {
  const written: string[] = [];
  const write = async (text: string): Promise<ClipboardResult> => {
    written.push(text);
    return ok ? { ok: true, via: ['osc52'] } : { ok: false, via: [], error: 'terminal refused' };
  };
  return { written, write };
}

const row = (text: string): Line => ({ segs: [{ text }] });

describe('OSC 52 sink', () => {
  it('encodes the payload as base64 in an OSC 52 clipboard sequence', () => {
    expect(osc52('hello')).toBe('\x1b]52;c;aGVsbG8=\x07');
  });

  it('writes OSC 52 to the terminal and reports the sink it used', async () => {
    const out: string[] = [];
    // platform: linux → no pbcopy path, so this asserts the OSC 52 leg alone.
    const write = createClipboard({ out: { write: (c: string) => out.push(c) }, platform: 'linux', env: {} });
    const res = await write('copy me');
    expect(res).toEqual({ ok: true, via: ['osc52'] });
    expect(out).toEqual([osc52('copy me')]);
  });

  it('skips the local pbcopy fallback over SSH (it would set the wrong machine’s clipboard)', async () => {
    const out: string[] = [];
    const write = createClipboard({
      out: { write: (c: string) => out.push(c) },
      platform: 'darwin',
      env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' },
    });
    const res = await write('remote');
    expect(res.via).toEqual(['osc52']); // OSC 52 only — no pbcopy
  });
});

describe('copy-mode state machine', () => {
  it('enters with the cursor on the last visible row and nothing anchored', () => {
    // 100 rows, a 10-row window scrolled to rows 20..29.
    expect(enterCopy({ top: 20, stuck: false }, 100, 10)).toEqual({ cursor: 29, anchor: null });
  });

  it('selects only the cursor row until `v` drops an anchor', () => {
    let s = { cursor: 5, anchor: null as number | null };
    expect(copyRange(s)).toEqual({ from: 5, to: 5 });
    s = toggleAnchor(s); // v
    s = moveCopy(s, 3, 100); // ↓↓↓ extends
    expect(copyRange(s)).toEqual({ from: 5, to: 8 });
  });

  it('extends upward too, and clamps at the buffer edges', () => {
    let s = toggleAnchor({ cursor: 4, anchor: null });
    s = moveCopy(s, -10, 100); // walk off the top
    expect(s.cursor).toBe(0);
    expect(copyRange(s)).toEqual({ from: 0, to: 4 });
    s = moveCopy(s, 500, 100); // walk off the bottom
    expect(s.cursor).toBe(99);
    expect(copyRange(s)).toEqual({ from: 4, to: 99 });
  });

  it('`v` again collapses the selection back to the cursor row', () => {
    const s = toggleAnchor(toggleAnchor({ cursor: 7, anchor: null }));
    expect(s.anchor).toBeNull();
    expect(copyRange(s)).toEqual({ from: 7, to: 7 });
  });

  it('select-all spans the whole buffer', () => {
    expect(copyRange(selectAll(12))).toEqual({ from: 0, to: 11 });
  });

  it('scrolls only as far as needed to keep the cursor on screen', () => {
    // Cursor above the window → window pins to it.
    expect(revealRow({ top: 20, stuck: false }, 12, 100, 10)).toEqual({ top: 12, stuck: false });
    // Cursor below the window → window ends on it.
    expect(revealRow({ top: 20, stuck: false }, 35, 100, 10)).toEqual({ top: 26, stuck: false });
    // Already visible → nothing moves.
    expect(revealRow({ top: 20, stuck: false }, 25, 100, 10)).toEqual({ top: 20, stuck: false });
  });

  it('flattens the selected rows back to plain text, right-trimmed', () => {
    const lines = [row('one'), row('two   '), row('three'), row('four')];
    expect(linesToText(lines, 1, 2)).toBe('two\nthree');
  });
});

describe('copy targets', () => {
  const entries: Entry[] = [
    { kind: 'user', text: 'what failed?' },
    { kind: 'tool', id: 't1', name: 'bash', input: { command: 'pnpm test' }, output: 'FAIL src/a.ts\n1 failed', isError: true, done: true },
    { kind: 'assistant', text: 'The suite is red: `src/a.ts` fails.', streaming: false },
  ];

  it('finds the last assistant message', () => {
    expect(lastAssistantText(entries)).toBe('The suite is red: `src/a.ts` fails.');
    expect(lastAssistantText([{ kind: 'user', text: 'hi' }])).toBe('');
  });

  it('renders a tool block as its invocation + full output (not the truncated view)', () => {
    expect(toolBlockText(entries, 't1')).toBe('bash({"command":"pnpm test"})\nFAIL src/a.ts\n1 failed');
    expect(toolBlockText(entries, 'nope')).toBe('');
  });

  it('renders the whole transcript', () => {
    const text = transcriptText(entries);
    expect(text).toContain('› what failed?');
    expect(text).toContain('FAIL src/a.ts');
    expect(text).toContain('The suite is red');
  });
});

describe('copy mode in the App', () => {
  async function* reply(): AsyncGenerator<LoopEvent> {
    yield { type: 'text_delta', text: 'ALPHA' };
    yield { type: 'turn_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
  }

  it('Ctrl+Space enters copy mode and shows the COPY MODE hint', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(reply), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, ['hi', KEY.enter], 30);
    await delay(80);

    stdin.write(KEY.ctrlSpace);
    await delay(60);
    const f = lastFrame()!;
    expect(f).toContain('COPY MODE');
    expect(f).toContain('press v to start a selection');
    expect(f).toContain('v select'); // the key hint (it wraps, so match a fragment)
    expect(f).toContain('esc cancel');
  });

  it('Esc leaves copy mode without copying', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(reply), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, ['hi', KEY.enter], 30);
    await delay(80);
    await typeSeq(stdin, [KEY.ctrlSpace, KEY.esc], 40);
    await delay(60);

    expect(clip.written).toEqual([]);
    const f = lastFrame()!;
    expect(f).not.toContain('COPY MODE');
    expect(f).toContain('copy mode: cancelled');
    expect(f).toContain('ask, or /help'); // prompt is back
  });

  it('extends a selection with v + ↑ and `y` writes those rows to the clipboard', async () => {
    const clip = fakeClipboard();
    // Transcript rows end with: "› hi", spacer, "ALPHA". Enter copy mode (cursor
    // on the last row), v, then ↑↑ to reach the user line → 3 rows selected.
    const { stdin, lastFrame } = renderApp(makeSession(reply), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, ['hi', KEY.enter], 30);
    await delay(80);

    await typeSeq(stdin, [KEY.ctrlSpace, 'v', KEY.up, KEY.up], 40);
    await delay(40);
    expect(lastFrame()).toContain('3 rows selected');

    stdin.write('y');
    await delay(80);

    expect(clip.written).toHaveLength(1);
    const payload = clip.written[0]!;
    expect(payload).toContain('hi'); // the user line
    expect(payload).toContain('ALPHA'); // the assistant reply
    expect(payload.split('\n')).toHaveLength(3);

    const f = lastFrame()!;
    expect(f).not.toContain('COPY MODE'); // y exits
    expect(f).toContain('copied 3 lines');
  });

  it('`y` with no anchor copies just the cursor row', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(reply), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, ['hi', KEY.enter], 30);
    await delay(80);
    await typeSeq(stdin, [KEY.ctrlSpace, 'y'], 40);
    await delay(80);

    expect(clip.written).toEqual(['ALPHA']);
    expect(lastFrame()).toContain('copied 1 line');
  });

  it('keys in copy mode never leak into the prompt', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(reply), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, [KEY.ctrlSpace, 'j', 'k', 'g'], 30);
    await delay(40);
    stdin.write(KEY.esc);
    await delay(60);
    // The prompt still shows its placeholder → nothing was typed into it.
    expect(lastFrame()).toContain('ask, or /help');
  });

  it('surfaces a clipboard failure instead of claiming success', async () => {
    const clip = fakeClipboard(false);
    const { stdin, lastFrame } = renderApp(makeSession(reply), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, ['hi', KEY.enter], 30);
    await delay(80);
    await typeSeq(stdin, [KEY.ctrlSpace, 'y'], 40);
    await delay(80);
    expect(lastFrame()).toContain('copy failed: terminal refused');
  });
});

describe('focused-tool copy + /copy', () => {
  async function* withTool(): AsyncGenerator<LoopEvent> {
    yield { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } };
    yield { type: 'tool_result', id: 't1', output: 'file-a\nfile-b', isError: false };
    yield { type: 'text_delta', text: 'Two files.' };
    yield { type: 'turn_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
  }

  it('`y` on a Ctrl+P-focused tool copies that block', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(withTool), { copyToClipboard: clip.write, rows: 30 });
    await delay();
    await typeSeq(stdin, ['go', KEY.enter], 30);
    await delay(100);

    await typeSeq(stdin, [KEY.ctrlP, 'y'], 40); // focus the tool, copy it
    await delay(80);

    expect(clip.written).toEqual(['bash({"command":"ls"})\nfile-a\nfile-b']);
    expect(lastFrame()).toContain('copied 3 lines — tool t1');
  });

  it('/copy copies the last assistant message', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(withTool), { copyToClipboard: clip.write, rows: 30 });
    await delay();
    await typeSeq(stdin, ['go', KEY.enter], 30);
    await delay(100);

    await typeSeq(stdin, ['/copy', KEY.enter], 30);
    await delay(80);

    expect(clip.written).toEqual(['Two files.']);
    expect(lastFrame()).toContain('the last reply');
  });

  it('/copy all copies the whole transcript, /copy tool the focused block', async () => {
    const clip = fakeClipboard();
    const { stdin } = renderApp(makeSession(withTool), { copyToClipboard: clip.write, rows: 30 });
    await delay();
    await typeSeq(stdin, ['go', KEY.enter], 30);
    await delay(100);

    await typeSeq(stdin, ['/copy all', KEY.enter], 30);
    await delay(80);
    expect(clip.written[0]).toContain('› go');
    expect(clip.written[0]).toContain('file-a');
    expect(clip.written[0]).toContain('Two files.');

    await typeSeq(stdin, [KEY.ctrlP], 30);
    await typeSeq(stdin, ['/copy tool', KEY.enter], 30);
    await delay(80);
    expect(clip.written[1]).toBe('bash({"command":"ls"})\nfile-a\nfile-b');
  });

  it('/copy with nothing to copy warns rather than silently doing nothing', async () => {
    const clip = fakeClipboard();
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { copyToClipboard: clip.write, rows: 24 });
    await delay();
    await typeSeq(stdin, ['/copy', KEY.enter], 30);
    await delay(60);
    expect(clip.written).toEqual([]);
    expect(lastFrame()).toContain('nothing to copy');
  });
});

// Capture now starts OFF (drag-select is the default; the wheel is opt-in), so
// the first `/mouse` turns it ON. See tui-mouse.test.tsx for the escape bytes.
describe('/mouse hands the mouse between the app and the terminal', () => {
  it('toggles capture on and back off, telling the user what changed', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 24 });
    await delay();
    // The notices are long enough to wrap in the transcript, so match against a
    // whitespace-flattened frame — we care about the words, not the line breaks.
    const flat = (): string => (lastFrame() ?? '').replace(/\s+/g, ' ');

    await typeSeq(stdin, ['/mouse', KEY.enter], 30);
    await delay(60);
    expect(flat()).toContain('mouse capture ON');
    expect(flat()).toContain('hold ⌥ (Option) and drag');

    await typeSeq(stdin, ['/mouse', KEY.enter], 30);
    await delay(60);
    expect(flat()).toContain('mouse capture OFF');
    expect(flat()).toContain('drag to select');
  });
});

describe('/help documents the copy keys', () => {
  it('lists copy mode, /copy, and the native-selection bypass', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { rows: 50 });
    await delay();
    await typeSeq(stdin, ['/help', KEY.enter], 30);
    await delay(80);
    const f = lastFrame()!;
    expect(f).toContain('COPY MODE');
    expect(f).toContain('Ctrl+Space');
    expect(f).toContain('OSC 52');
    expect(f).toContain('/mouse');
    expect(f).toContain('Shift');
  });
});
