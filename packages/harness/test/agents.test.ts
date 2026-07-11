import { describe, it, expect } from 'vitest';
import { createSession } from '../src/loop/index.js';
import {
  createAgentTools,
  createAgentRegistry,
  subAgentRegistry,
  runSubAgent,
  promptPreview,
} from '../src/agents/index.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type {
  PermissionGate,
  Provider,
  StreamEvent,
  StreamRequest,
  Tool,
  ToolContext,
} from '../src/types.js';

const allowAll: PermissionGate = { request: async () => true };
const noSignalCtx: ToolContext = { cwd: '/tmp', permission: allowAll };

/** A one-turn provider that just answers with `text`. */
function answerProvider(text: string): Provider {
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(_req: StreamRequest): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', text };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

/** A provider that blocks until aborted (for kill/interrupt tests). */
function blockingProvider(): Provider {
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', text: 'working…' };
      await new Promise<void>((_res, reject) => {
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (req.signal?.aborted) return onAbort();
        req.signal?.addEventListener('abort', onAbort);
      });
    },
  };
}

function baseConfig(provider: Provider, tools: Tool[] = []) {
  return {
    provider,
    providerId: 'anthropic' as const,
    model: 'claude-opus-4-8',
    systemPrompt: 'sub-agent',
    tools,
    cwd: '/tmp',
    permission: allowAll,
    authMode: 'api' as const,
    authSource: 'test',
  };
}

/** A factory that hands out a fresh session answering `${answer} #N`. */
function countingFactory(answer: string) {
  let n = 0;
  return () => createSession(baseConfig(answerProvider(`${answer} ${++n}`)));
}

describe('runSubAgent', () => {
  it('drives a session to completion and collects its final text + usage', async () => {
    const session = createSession(baseConfig(answerProvider('the answer is 42')));
    const res = await runSubAgent(session, 'what is 6*7?');
    expect(res.text).toBe('the answer is 42');
    expect(res.isError).toBe(false);
    expect(res.usage.inputTokens).toBe(10);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('reports an aborted sub-run cleanly (no throw)', async () => {
    const session = createSession(baseConfig(blockingProvider()));
    const ac = new AbortController();
    const p = runSubAgent(session, 'loop forever', { signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(res.text).toContain('working');
    expect(res.isError).toBe(false); // an interrupt ends the turn cleanly
  });
});

describe('spawn_agent tool', () => {
  it('foreground: runs a single sub-agent and returns its answer', async () => {
    const { tools } = createAgentTools({ makeSubSession: countingFactory('done') });
    const spawn = tools.find((t) => t.spec.name === 'spawn_agent')!;
    const res = await spawn.run({ prompt: 'do a thing' }, noSignalCtx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('done 1');
  });

  it('foreground batch: runs several prompts in parallel, preserves order', async () => {
    const { tools } = createAgentTools({ makeSubSession: countingFactory('r') });
    const spawn = tools.find((t) => t.spec.name === 'spawn_agent')!;
    const res = await spawn.run({ prompts: ['a', 'b', 'c'] }, noSignalCtx);
    // Three sub-agents, each labeled with its index, in submission order.
    expect(res.content).toContain('sub-agent 1/3');
    expect(res.content).toContain('sub-agent 2/3');
    expect(res.content).toContain('sub-agent 3/3');
    expect((res.content.match(/\br \d/g) ?? []).length).toBe(3);
  });

  it('background: returns handles immediately and runs via startBackground', async () => {
    const started: string[] = [];
    const { tools } = createAgentTools({
      makeSubSession: countingFactory('bg'),
      startBackground: (prompt, _job, o) => {
        started.push(o?.label ?? prompt);
        return { id: `agent${started.length}` };
      },
    });
    const spawn = tools.find((t) => t.spec.name === 'spawn_agent')!;
    const res = await spawn.run({ prompts: ['x', 'y'], background: true }, noSignalCtx);
    expect(res.content).toContain('agent1');
    expect(res.content).toContain('agent2');
    expect(res.content).toContain('/tasks');
    expect(started).toHaveLength(2);
  });

  it('errors on empty input', async () => {
    const { tools } = createAgentTools({ makeSubSession: countingFactory('x') });
    const spawn = tools.find((t) => t.spec.name === 'spawn_agent')!;
    const res = await spawn.run({}, noSignalCtx);
    expect(res.isError).toBe(true);
  });

  it('runForeground backs the /agent command', async () => {
    const { runForeground } = createAgentTools({ makeSubSession: countingFactory('cmd') });
    const res = await runForeground('hello');
    expect(res.text).toBe('cmd 1');
  });
});

describe('AgentRegistry (background /tasks surface)', () => {
  it('tracks a background sub-agent from running → done with BgTask-like snapshot', async () => {
    const reg = createAgentRegistry();
    const updates: string[] = [];
    reg.onUpdate((t) => updates.push(t.status));
    const task = reg.start('audit the code', async () => ({
      text: 'found 2 issues',
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.01,
      isError: false,
    }));
    expect(task.id).toBe('agent1');
    expect(task.status).toBe('running');
    expect(task.label).toContain('sub-agent:');
    // let the microtask resolve
    await new Promise((r) => setTimeout(r, 0));
    const done = reg.get('agent1')!;
    expect(done.status).toBe('done');
    expect(done.output).toBe('found 2 issues');
    expect(reg.runningCount()).toBe(0);
    expect(updates).toContain('done');
  });

  it('kill() cancels a running background sub-agent', async () => {
    const reg = createAgentRegistry();
    let sawAbort = false;
    reg.start('long job', (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, isError: false });
        });
      }),
    );
    expect(reg.kill('agent1')).toBe(true);
    expect(reg.get('agent1')!.status).toBe('killed');
    expect(sawAbort).toBe(true);
    expect(reg.kill('nope')).toBe(false);
  });
});

describe('subAgentRegistry (live view, no spawn_agent)', () => {
  const tool = (name: string): Tool => ({
    spec: { name, description: name, inputSchema: { type: 'object' } },
    async run() {
      return { content: name };
    },
  });

  it('excludes spawn_agent but reflects tools registered AFTER the view is made', () => {
    const base = createToolRegistry([tool('read'), tool('spawn_agent')]);
    const view = subAgentRegistry(base);
    // spawn_agent hidden so a sub-agent can't recurse
    expect(view.list().map((t) => t.spec.name)).toEqual(['read']);
    expect(view.get('spawn_agent')).toBeUndefined();
    // a late arrival (e.g. an MCP tool finishing its async connect) shows up live
    base.register(tool('mcp__srv__do'));
    expect(view.list().map((t) => t.spec.name)).toEqual(['read', 'mcp__srv__do']);
    expect(view.get('mcp__srv__do')).toBeDefined();
  });
});

describe('promptPreview', () => {
  it('collapses whitespace and truncates', () => {
    expect(promptPreview('hello   world')).toBe('hello world');
    expect(promptPreview('x'.repeat(100), 10)).toHaveLength(10);
  });
});
