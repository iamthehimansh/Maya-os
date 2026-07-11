import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextManager, createCompactTool, transcriptText, type Compactable } from '../src/context/index.js';
import { createToolRegistry, builtinTools } from '../src/tools/index.js';
import { memoryTool } from '../src/memory/index.js';
import type { ModelMessage, SessionState } from '../src/types.js';

let root: string;
let globalDir: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mayac-ctx-'));
  globalDir = join(root, 'g');
  projectDir = join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const userMsg = (text: string): ModelMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asstMsg = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

describe('assembleSystem', () => {
  it('returns the base prompt verbatim when there is no memory', async () => {
    const cm = createContextManager({ basePrompt: 'BASE', cwd: projectDir, globalDir });
    await cm.load();
    expect(cm.assembleSystem()).toBe('BASE');
  });

  it('folds global + project memory into the system prompt', async () => {
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'MAYAC.md'), 'global rule', 'utf8');
    await writeFile(join(projectDir, 'MAYAC.md'), 'project rule', 'utf8');

    const cm = createContextManager({ basePrompt: 'BASE', cwd: projectDir, globalDir });
    await cm.load();
    const sys = cm.assembleSystem();
    expect(sys.startsWith('BASE')).toBe(true);
    expect(sys).toContain('# Memory');
    expect(sys).toContain('global rule');
    expect(sys).toContain('project rule');
    expect(cm.memory.files.length).toBe(2);
  });

  it('folds memory into a caller-supplied base prompt (sub-agent custom prompt wins)', async () => {
    await writeFile(join(projectDir, 'MAYAC.md'), 'shared rule', 'utf8');
    const cm = createContextManager({ basePrompt: 'MAIN PROMPT', cwd: projectDir, globalDir });
    await cm.load();
    // Default uses the configured base…
    expect(cm.assembleSystem().startsWith('MAIN PROMPT')).toBe(true);
    // …but an override base (a sub-agent's own prompt) wins, still inheriting memory.
    const sub = cm.assembleSystem('SUBAGENT PROMPT');
    expect(sub.startsWith('SUBAGENT PROMPT')).toBe(true);
    expect(sub).not.toContain('MAIN PROMPT');
    expect(sub).toContain('shared rule');
  });

  it('reload() picks up a memory file added after the first load', async () => {
    const cm = createContextManager({ basePrompt: 'BASE', cwd: projectDir, globalDir });
    await cm.load();
    expect(cm.assembleSystem()).toBe('BASE');
    await writeFile(join(projectDir, 'MAYAC.md'), 'new note', 'utf8');
    await cm.reload();
    expect(cm.assembleSystem()).toContain('new note');
  });

  it('accepts preloaded memory without touching disk', () => {
    const cm = createContextManager({
      basePrompt: 'B',
      cwd: projectDir,
      memory: { files: [{ scope: 'project', path: '/x', content: 'preloaded' }], chars: 9 },
    });
    expect(cm.assembleSystem()).toContain('preloaded');
  });
});

describe('estimateTokens', () => {
  it('grows with message content and includes the system prompt', () => {
    const cm = createContextManager({ basePrompt: 'x'.repeat(40), cwd: projectDir });
    const small = cm.estimateTokens([userMsg('hi')]);
    const big = cm.estimateTokens([userMsg('hi'), asstMsg('y'.repeat(4000))]);
    expect(big).toBeGreaterThan(small);
    // 40-char system prompt alone ≈ 10 tokens floor.
    expect(cm.estimateTokens([])).toBeGreaterThanOrEqual(10);
  });
});

describe('assembleContext — auto-compaction', () => {
  const summarize = async (t: string) => `SUMMARY(${t.length} chars)`;

  it('is a no-op below the threshold (returns the same messages ref)', async () => {
    const cm = createContextManager({ basePrompt: 'B', cwd: projectDir, contextLimit: 1_000_000 });
    const msgs = [userMsg('a'), asstMsg('b'), userMsg('c'), asstMsg('d')];
    const res = await cm.assembleContext(msgs, { summarize });
    expect(res.compacted).toBeUndefined();
    expect(res.messages).toBe(msgs);
  });

  it('compacts when over the threshold: summary + kept tail, reports before>after', async () => {
    // Tiny limit forces compaction. keepRecent default 6, so give more than that.
    const cm = createContextManager({
      basePrompt: 'B',
      cwd: projectDir,
      contextLimit: 100,
      compactThreshold: 0.1,
      keepRecent: 2,
    });
    const msgs = [
      userMsg('old question one'),
      asstMsg('old answer one'),
      userMsg('old question two'),
      asstMsg('old answer two'),
      userMsg('recent question'),
      asstMsg('recent answer'),
    ];
    const res = await cm.assembleContext(msgs, { summarize });
    expect(res.compacted).toBeDefined();
    expect(res.compacted!.before).toBeGreaterThan(res.compacted!.after);
    // First message is the summary, last two are the kept tail verbatim.
    expect(res.messages[0]!.content[0]).toMatchObject({ type: 'text' });
    expect((res.messages[0]!.content[0] as { text: string }).text).toContain('SUMMARY');
    expect(res.messages.at(-1)).toMatchObject(asstMsg('recent answer'));
    expect(res.messages.at(-2)).toMatchObject(userMsg('recent question'));
  });

  it('force compacts on /compact even below the threshold', async () => {
    const cm = createContextManager({ basePrompt: 'B', cwd: projectDir, contextLimit: 1_000_000, keepRecent: 2 });
    const msgs = [userMsg('a'), asstMsg('b'), userMsg('c'), asstMsg('d')];
    const res = await cm.assembleContext(msgs, { summarize, force: true });
    expect(res.compacted).toBeDefined();
  });

  it('never orphans a tool_result: snaps the kept tail back to a clean user turn', async () => {
    const cm = createContextManager({
      basePrompt: 'B',
      cwd: projectDir,
      contextLimit: 100,
      compactThreshold: 0.1,
      keepRecent: 2, // naive cut would land ON the tool_result user message
    });
    const msgs: ModelMessage[] = [
      userMsg('do a thing'),
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_call', id: 't1', name: 'echo', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'result' }] },
      asstMsg('final answer'),
    ];
    const res = await cm.assembleContext(msgs, { summarize });
    expect(res.compacted).toBeDefined();
    // The kept tail must NOT start with a tool_result message.
    const firstKept = res.messages[1];
    const startsWithToolResult = firstKept?.content.some((b) => b.type === 'tool_result');
    expect(startsWithToolResult).toBeFalsy();
  });

  it('falls back to a placeholder when the summarizer throws', async () => {
    const cm = createContextManager({
      basePrompt: 'B',
      cwd: projectDir,
      contextLimit: 100,
      compactThreshold: 0.1,
      keepRecent: 2,
    });
    const msgs = [userMsg('a'.repeat(50)), asstMsg('b'), userMsg('c'), asstMsg('d')];
    const boom = async () => {
      throw new Error('provider down');
    };
    const res = await cm.assembleContext(msgs, { summarize: boom });
    expect(res.compacted).toBeDefined();
    expect((res.messages[0]!.content[0] as { text: string }).text).toContain('truncated');
  });
});

describe('createCompactTool (agent tool)', () => {
  const state = (contextTokens: number): SessionState => ({
    provider: 'anthropic',
    model: 'm',
    authMode: 'api',
    authSource: 'test',
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    contextTokens,
  });

  it('is registered as a no-arg tool named "compact"', () => {
    const tool = createCompactTool({ compact: async () => null, state: state(0) });
    expect(tool.spec.name).toBe('compact');
    expect(tool.spec.inputSchema).toMatchObject({ properties: {} });
  });

  it('reports before/after token counts when compaction happens', async () => {
    let called = false;
    const session: Compactable = {
      compact: async () => {
        called = true;
        return { before: 5000, after: 1200 };
      },
      state: state(1200),
    };
    const res = await createCompactTool(session).run(undefined, { cwd: '.', permission: { request: async () => true } });
    expect(called).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('5000');
    expect(res.content).toContain('1200');
    expect(res.content).toContain('3800'); // freed
  });

  it('reports a no-op when there is nothing to compact', async () => {
    const session: Compactable = { compact: async () => null, state: state(42) };
    const res = await createCompactTool(session).run(undefined, { cwd: '.', permission: { request: async () => true } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Nothing to compact');
    expect(res.content).toContain('42');
  });

  it('surfaces a compaction error as isError', async () => {
    const session: Compactable = {
      compact: async () => {
        throw new Error('boom');
      },
      state: state(0),
    };
    const res = await createCompactTool(session).run(undefined, { cwd: '.', permission: { request: async () => true } });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('boom');
  });

  it('lands in the model tool registry the way cli.ts wires it', () => {
    // Mirrors cli.ts: seed builtins + memory tools, then register compact over
    // the live session. The model reads registry.list() each turn — assert the
    // agent-callable memory + compact tools are present.
    const registry = createToolRegistry([...builtinTools(), memoryTool]);
    registry.register(createCompactTool({ compact: async () => null, state: state(0) }));
    const names = registry.list().map((t) => t.spec.name);
    expect(names).toContain('memory');
    expect(names).toContain('compact');
    expect(registry.get('compact')?.spec.inputSchema).toMatchObject({ properties: {} });
  });
});

describe('transcriptText', () => {
  it('flattens roles, tool calls, and tool results', () => {
    const t = transcriptText([
      userMsg('question'),
      { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'grep', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'match' }] },
    ]);
    expect(t).toContain('user: question');
    expect(t).toContain('calls grep');
    expect(t).toContain('tool_result: match');
  });
});
