import { describe, it, expect } from 'vitest';
import type { LoopEvent } from '../src/types.js';
import {
  renderApp,
  makeSession,
  makeStore,
  makeHistory,
  makeTasks,
  makeModels,
  endTurn,
  delay,
  KEY,
} from './_app-harness.js';

const usage = { inputTokens: 5, outputTokens: 5 };
const end = (): LoopEvent => ({ type: 'turn_end', stopReason: 'end_turn', usage, costUsd: 0 });

async function typeSeq(stdin: { write(s: string): void }, seqs: string[], each = 25): Promise<void> {
  for (const s of seqs) {
    stdin.write(s);
    await delay(each);
  }
}

describe('layout regions', () => {
  it('renders header (provider/model/auth), viewport, and input placeholder', async () => {
    const { lastFrame } = renderApp(makeSession(endTurn));
    await delay();
    const f = lastFrame()!;
    expect(f).toContain('maya code');
    expect(f).toContain('anthropic');
    expect(f).toContain('claude-opus-4-8');
    expect(f).toContain('api');
    expect(f).toContain('ask, or /help');
  });
});

describe('streaming a turn + tool collapse', () => {
  async function* run(): AsyncGenerator<LoopEvent> {
    yield { type: 'text_delta', text: 'Let me check.' };
    yield { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } };
    yield { type: 'tool_result', id: 't1', output: 'file-a\nfile-b', isError: false };
    yield { type: 'text_delta', text: 'Done.' };
    yield end();
  }
  it('shows assistant text and the tool block, most-recent tool expanded', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(run));
    await delay();
    await typeSeq(stdin, ['hello'.split('').join(''), KEY.enter]);
    await delay(80);
    const f = lastFrame()!;
    expect(f).toContain('Let me check.');
    expect(f).toContain('bash');
    expect(f).toContain('file-a'); // latest tool auto-expanded → output visible
    expect(f).toContain('Done.');
  });

  it('collapses an older tool once a newer one arrives', async () => {
    async function* two(): AsyncGenerator<LoopEvent> {
      yield { type: 'tool_call', id: 'a', name: 'bash', input: { command: 'first-cmd' } };
      yield { type: 'tool_result', id: 'a', output: 'FIRST-OUTPUT', isError: false };
      yield { type: 'tool_call', id: 'b', name: 'bash', input: { command: 'second-cmd' } };
      yield { type: 'tool_result', id: 'b', output: 'SECOND-OUTPUT', isError: false };
      yield end();
    }
    const { stdin, lastFrame } = renderApp(makeSession(two));
    await delay();
    await typeSeq(stdin, ['go', KEY.enter]);
    await delay(90);
    const f = lastFrame()!;
    expect(f).toContain('SECOND-OUTPUT'); // newest expanded
    expect(f).not.toContain('FIRST-OUTPUT'); // older collapsed
    expect(f).toContain('first-cmd'); // but its summary line remains
  });
});

describe('tool focus: navigate + expand a collapsed call', () => {
  async function* two(): AsyncGenerator<LoopEvent> {
    yield { type: 'tool_call', id: 'a', name: 'bash', input: { command: 'older' } };
    yield { type: 'tool_result', id: 'a', output: 'OLDER-OUTPUT', isError: false };
    yield { type: 'tool_call', id: 'b', name: 'bash', input: { command: 'newer' } };
    yield { type: 'tool_result', id: 'b', output: 'NEWER-OUTPUT', isError: false };
    yield end();
  }
  it('Ctrl+P focuses a tool and → expands the older collapsed one', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(two), { rows: 40 });
    await delay();
    await typeSeq(stdin, ['go', KEY.enter]);
    await delay(90);
    expect(lastFrame()).not.toContain('OLDER-OUTPUT');
    // Focus most-recent tool, move up to the older one, expand it.
    await typeSeq(stdin, [KEY.ctrlP, KEY.up, KEY.right]);
    await delay(50);
    expect(lastFrame()).toContain('OLDER-OUTPUT');
  });
});

describe('scroll viewport', () => {
  it('PageUp reveals a "more above" affordance on a long transcript', async () => {
    async function* many(): AsyncGenerator<LoopEvent> {
      for (let i = 0; i < 40; i++) yield { type: 'text_delta', text: `line ${i}\n` };
      yield end();
    }
    const { stdin, lastFrame } = renderApp(makeSession(many), { rows: 16 });
    await delay();
    await typeSeq(stdin, ['go', KEY.enter]);
    await delay(120);
    // Auto-stuck at the bottom: nothing new below.
    expect(lastFrame()).not.toContain('new below');
    expect(lastFrame()).not.toContain('more below');
    // Scroll up → releases the stick, older rows + a "new below" affordance appear.
    await typeSeq(stdin, [KEY.pageUp, KEY.pageUp]);
    await delay(40);
    expect(lastFrame()).toContain('more above');
    expect(lastFrame()).toContain('below');
  });

  it('mouse wheel scrolls the viewport (SGR wheel-up) without corrupting the input line', async () => {
    async function* many(): AsyncGenerator<LoopEvent> {
      for (let i = 0; i < 40; i++) yield { type: 'text_delta', text: `line ${i}\n` };
      yield end();
    }
    const { stdin, lastFrame } = renderApp(makeSession(many), { rows: 16 });
    await delay();
    await typeSeq(stdin, ['go', KEY.enter]);
    await delay(120);
    // Auto-stuck at the bottom: nothing new below.
    expect(lastFrame()).not.toContain('new below');
    expect(lastFrame()).not.toContain('more below');
    // SGR wheel-up report (btn 64) a few notches → releases the stick, scrolls up.
    const WHEEL_UP = '\x1b[<64;10;5M';
    await typeSeq(stdin, [WHEEL_UP, WHEEL_UP, WHEEL_UP, WHEEL_UP, WHEEL_UP]);
    await delay(40);
    expect(lastFrame()).toContain('more above');
    expect(lastFrame()).toContain('below');
    // The raw mouse bytes must NOT leak into the prompt: input stays empty.
    expect(lastFrame()).toContain('ask, or /help');
  });
});

describe('autocomplete', () => {
  it('shows slash commands as you type and Tab accepts', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn));
    await delay();
    await typeSeq(stdin, ['/', 'm', 'o', 'd']);
    await delay(40);
    expect(lastFrame()).toContain('/model');
    await typeSeq(stdin, [KEY.tab]);
    await delay(40);
    // Accepting fills the line with "/model " (menu then closes on the space).
    expect(lastFrame()).toContain('/model');
  });

  it('Enter accepts the highlighted slash command and runs the FULL command, not the half-typed text', async () => {
    const fetchModels = makeModels([
      { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic' },
    ]);
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { fetchModels });
    await delay();
    // Type a partial command; the menu highlights the full "/model".
    await typeSeq(stdin, ['/', 'm', 'o', 'd']);
    await delay(40);
    expect(lastFrame()).toContain('/model');
    // Enter must accept "/model" and run it — NOT submit the partial "/mod".
    await typeSeq(stdin, [KEY.enter]);
    await delay(60);
    const f = lastFrame()!;
    expect(f).toContain('Select model');           // full /model executed → picker opened
    expect(f).not.toContain('unknown command');    // partial /mod was never submitted
  });

  it('completes @-file tokens from the cwd', async () => {
    const listDir = () => ['index.ts', 'tui/'];
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { listDir });
    await delay();
    await typeSeq(stdin, ['@', 'i', 'n']); // token "@in"
    await delay(40);
    expect(lastFrame()).toContain('index.ts');
  });
});

describe('command history recall', () => {
  it('Up arrow recalls the previous command', async () => {
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { history: makeHistory(['earlier-cmd']) });
    await delay();
    await typeSeq(stdin, [KEY.up]);
    await delay(40);
    expect(lastFrame()).toContain('earlier-cmd');
  });
});

describe('background tasks', () => {
  it('/bg starts a task and the header shows the bg chip', async () => {
    const tasks = makeTasks();
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { tasks });
    await delay();
    await typeSeq(stdin, ['/bg echo hi', KEY.enter], 30);
    await delay(60);
    expect(tasks.list().length).toBe(1);
    expect(lastFrame()).toContain('bg'); // "⚙ 1 bg" chip
  });

  it('/tasks opens the tasks overlay listing the running task', async () => {
    const tasks = makeTasks();
    tasks.start('sleep 100', {});
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { tasks });
    await delay();
    await typeSeq(stdin, ['/tasks', KEY.enter], 30);
    await delay(50);
    const f = lastFrame()!;
    expect(f).toContain('Background tasks');
    expect(f).toContain('sleep 100');
  });
});

describe('model picker (dynamic list)', () => {
  it('/model lists models from the injected fetch', async () => {
    const fetchModels = makeModels([
      { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'anthropic' },
    ]);
    const { stdin, lastFrame } = renderApp(makeSession(endTurn), { fetchModels });
    await delay();
    await typeSeq(stdin, ['/model', KEY.enter], 30);
    await delay(60);
    const f = lastFrame()!;
    expect(f).toContain('Select model');
    expect(f).toContain('Opus 4.8');
    expect(f).toContain('Sonnet 5');
  });
});
