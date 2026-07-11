import { describe, it, expect } from 'vitest';
import type { LoopEvent, RunInput } from '../src/types.js';
import type { FsLike } from '../src/tui/attach.js';
import { renderApp, makeSession, delay, KEY } from './_app-harness.js';

const usage = { inputTokens: 1, outputTokens: 1 };

/** A session that records the RunInput each turn receives. */
function capturingSession() {
  const seen: RunInput[] = [];
  async function* run(input: RunInput): AsyncGenerator<LoopEvent> {
    seen.push(input);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'turn_end', stopReason: 'end_turn', usage, costUsd: 0 };
  }
  return { session: makeSession(run as never), seen };
}

/** A fake fs exposing a fixed set of files. */
function fs(files: Record<string, Buffer | string>): FsLike {
  return {
    statSync(p) {
      const f = files[p];
      if (f === undefined) throw new Error('ENOENT');
      const buf = typeof f === 'string' ? Buffer.from(f) : f;
      return { isFile: () => true, size: buf.length };
    },
    readFileSync(p) {
      const f = files[p];
      if (f === undefined) throw new Error('ENOENT');
      return typeof f === 'string' ? Buffer.from(f) : f;
    },
  };
}

describe('item 3 — attachments (drag & paste)', () => {
  it('drops a text-file path → chip, then inlines its contents into the sent message', async () => {
    const { session, seen } = capturingSession();
    const { stdin, lastFrame } = renderApp(session, {
      attachFs: fs({ '/repo/notes.md': 'hello\nworld' }),
      rows: 30,
    });
    await delay();

    stdin.write('/repo/notes.md'); // terminal pastes the path on drag
    await delay(40);
    expect(lastFrame()).toContain('📄 notes.md');

    stdin.write('review this');
    await delay(20);
    stdin.write(KEY.enter);
    await delay(60);

    expect(seen).toHaveLength(1);
    const sent = seen[0] as string;
    expect(typeof sent).toBe('string');
    expect(sent).toContain('review this');
    expect(sent).toContain('[Attached file: notes.md]');
    expect(sent).toContain('hello\nworld');
  });

  it('drops an image path → chip, and sends it as an image content block', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const { session, seen } = capturingSession();
    const { stdin, lastFrame } = renderApp(session, {
      attachFs: fs({ '/repo/pic.png': png }),
      rows: 30,
    });
    await delay();

    stdin.write('/repo/pic.png');
    await delay(40);
    expect(lastFrame()).toContain('📎 pic.png');

    stdin.write('what is this');
    await delay(20);
    stdin.write(KEY.enter);
    await delay(60);

    const sent = seen[0] as Array<{ type: string; mediaType?: string; data?: string }>;
    expect(Array.isArray(sent)).toBe(true);
    const image = sent.find((b) => b.type === 'image');
    expect(image?.mediaType).toBe('image/png');
    expect(image?.data).toBe(png.toString('base64'));
  });

  it('removes the last staged attachment on Backspace when the prompt is empty', async () => {
    const { session } = capturingSession();
    const { stdin, lastFrame } = renderApp(session, {
      attachFs: fs({ '/repo/a.md': 'x' }),
      rows: 30,
    });
    await delay();
    stdin.write('/repo/a.md');
    await delay(40);
    expect(lastFrame()).toContain('📄 a.md');
    stdin.write(KEY.backspace);
    await delay(40);
    expect(lastFrame()).not.toContain('📄 a.md');
  });
});

describe('item 4 — multiline prompt', () => {
  it('a trailing backslash + Enter inserts a newline instead of submitting', async () => {
    const { session, seen } = capturingSession();
    const { stdin } = renderApp(session, { rows: 30 });
    await delay();

    stdin.write('line1');
    await delay(20);
    stdin.write('\\'); // single backslash char
    await delay(20);
    stdin.write(KEY.enter); // continuation — must NOT submit
    await delay(40);
    expect(seen).toHaveLength(0);

    stdin.write('line2');
    await delay(20);
    stdin.write(KEY.enter); // now submit
    await delay(60);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('line1\nline2');
  });

  it('collapses a large multi-line paste into a chip (not dumped into the prompt)', async () => {
    const { session } = capturingSession();
    const { stdin, lastFrame } = renderApp(session, { rows: 30 });
    await delay();

    stdin.write('l1\nl2\nl3\nl4\nl5');
    await delay(50);
    const f = lastFrame()!;
    expect(f).toContain('pasted 5 lines');
    // the raw lines are NOT shown verbatim on the prompt line
    expect(f).not.toContain('l3\nl4');
  });
});

describe('item 6 — interleaved text → tool → text rendering', () => {
  it('renders text, then the tool call, then more text in the model’s true order', async () => {
    async function* run(): AsyncGenerator<LoopEvent> {
      yield { type: 'text_delta', text: 'First I will check. ' };
      yield { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } };
      yield { type: 'text_delta', text: 'Now analyzing. ' };
      yield { type: 'tool_result', id: 't1', output: 'file.txt', isError: false };
      yield { type: 'text_delta', text: 'Done.' };
      yield { type: 'turn_end', stopReason: 'end_turn', usage, costUsd: 0 };
    }
    const { stdin, lastFrame } = renderApp(makeSession(run as never), { rows: 30 });
    await delay();

    stdin.write('go');
    await delay(20);
    stdin.write(KEY.enter);
    await delay(80);

    const f = lastFrame()!;
    const iFirst = f.indexOf('First I will check');
    const iBash = f.indexOf('bash');
    const iNow = f.indexOf('Now analyzing');
    expect(iFirst).toBeGreaterThanOrEqual(0);
    expect(iBash).toBeGreaterThan(iFirst);
    expect(iNow).toBeGreaterThan(iBash);
  });
});
