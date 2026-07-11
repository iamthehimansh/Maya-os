/**
 * Integration: the @context ContextManager wired INTO the real session/loop.
 * Proves item 7 (auto-compact + /compact) end-to-end — memory folded into the
 * request system prompt, auto-compaction firing mid-run, and `session.compact()`
 * (the /compact command) summarizing via the provider and reporting before/after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/loop/index.js';
import { createContextManager } from '../src/context/index.js';
import type { LoopEvent, ModelMessage, Provider, StreamEvent, StreamRequest } from '../src/types.js';

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mayac-ctxloop-'));
  projectDir = join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Provider that answers a summarize request with a fixed synopsis; else plays scripted turns. */
function scriptedProvider(turns: StreamEvent[][]): Provider {
  let i = 0;
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      if (req.system?.startsWith('Summarize')) {
        yield { type: 'text_delta', text: 'CONCISE SYNOPSIS OF EARLIER WORK' };
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }];
      for (const ev of turn) yield ev;
    },
  };
}

function makeSession(provider: Provider, context: ReturnType<typeof createContextManager>) {
  return createSession({
    provider,
    providerId: 'anthropic',
    model: 'claude-opus-4-8',
    systemPrompt: 'BASE PROMPT',
    tools: [],
    cwd: projectDir,
    permission: { request: async () => true },
    authMode: 'api',
    authSource: 'test',
    context,
    contextLimit: 100,
    compactThreshold: 0.1,
  });
}

const big = (tag: string): ModelMessage[] => [
  { role: 'user', content: [{ type: 'text', text: `${tag} question ` + 'x'.repeat(400) }] },
  { role: 'assistant', content: [{ type: 'text', text: `${tag} answer ` + 'y'.repeat(400) }] },
];

describe('ContextManager wired into the session', () => {
  it('folds project memory into the request system prompt', async () => {
    await writeFile(join(projectDir, 'MAYAC.md'), 'PROJECT CONVENTION XYZZY', 'utf8');
    const context = createContextManager({ basePrompt: 'BASE PROMPT', cwd: projectDir });
    await context.load();

    // Capture the system prompt the provider actually receives.
    let seenSystem = '';
    const provider: Provider = {
      id: 'anthropic',
      models: ['claude-opus-4-8'],
      async *stream(req: StreamRequest) {
        seenSystem = req.system ?? '';
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const session = makeSession(provider, context);
    for await (const _ of session.run('hi')) { /* drain */ }
    expect(seenSystem).toContain('BASE PROMPT');
    expect(seenSystem).toContain('PROJECT CONVENTION XYZZY');
  });

  it('auto-compacts mid-run and emits a compacted event', async () => {
    const context = createContextManager({ basePrompt: 'BASE PROMPT', cwd: projectDir, contextLimit: 100, compactThreshold: 0.1, keepRecent: 2 });
    await context.load();
    const provider = scriptedProvider([[{ type: 'text_delta', text: 'answer' }, { type: 'done', stopReason: 'end_turn' }]]);
    const session = makeSession(provider, context);
    // Preload a large transcript so the very first maybeCompact() crosses the tiny limit.
    session.loadMessages([...big('a'), ...big('b'), ...big('c')]);

    const events: LoopEvent[] = [];
    for await (const ev of session.run('new question')) events.push(ev);

    const compacted = events.find((e) => e.type === 'compacted');
    expect(compacted).toBeDefined();
    // Summary message replaced the old bulk; transcript is now smaller.
    const hasSynopsis = session.messages.some((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('CONCISE SYNOPSIS')),
    );
    expect(hasSynopsis).toBe(true);
  });

  it('session.compact() (the /compact command) summarizes and reports before>after', async () => {
    const context = createContextManager({ basePrompt: 'BASE PROMPT', cwd: projectDir, keepRecent: 2 });
    await context.load();
    const provider = scriptedProvider([]);
    const session = makeSession(provider, context);
    session.loadMessages([...big('a'), ...big('b'), ...big('c')]);

    const result = await session.compact();
    expect(result).not.toBeNull();
    expect(result!.before).toBeGreaterThan(result!.after);
    expect(session.messages[0]!.content[0]).toMatchObject({ type: 'text' });
    expect((session.messages[0]!.content[0] as { text: string }).text).toContain('CONCISE SYNOPSIS');
  });
});
