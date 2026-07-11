import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runWorkflow, runWorkflowFile, parallel, pipeline, makeWorkflowAgent } from '../src/workflow/index.js';
import { createSession } from '../src/loop/index.js';
import type { PermissionGate, Provider, StreamEvent, StreamRequest } from '../src/types.js';

const allowAll: PermissionGate = { request: async () => true };

function answerProvider(text: string): Provider {
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(_req: StreamRequest): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', text };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

function baseConfig(provider: Provider) {
  return {
    provider,
    providerId: 'anthropic' as const,
    model: 'claude-opus-4-8',
    systemPrompt: 'sub',
    tools: [],
    cwd: '/tmp',
    permission: allowAll,
    authMode: 'api' as const,
    authSource: 'test',
  };
}

describe('workflow primitives', () => {
  it('parallel runs thunks concurrently and returns all results', async () => {
    const order: number[] = [];
    const mk = (n: number, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
      return n;
    };
    // 1 is slowest → if concurrent, it still resolves; results keep input order.
    const res = await parallel([mk(1, 20), mk(2, 5), mk(3, 1)]);
    expect(res).toEqual([1, 2, 3]);
    expect(order).toEqual([3, 2, 1]); // finished fastest-first ⇒ truly concurrent
  });

  it('parallel maps a throwing thunk to null', async () => {
    const res = await parallel([async () => 'ok', async () => { throw new Error('boom'); }]);
    expect(res).toEqual(['ok', null]);
  });

  it('pipeline flows each item through all stages with no barrier', async () => {
    const res = await pipeline(
      [1, 2, 3],
      async (n) => (n as number) * 2,
      async (n) => `#${n}`,
    );
    expect(res).toEqual(['#2', '#4', '#6']);
  });

  it('pipeline drops a throwing item to null but keeps the rest', async () => {
    const res = await pipeline(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('bad');
        return n;
      },
    );
    expect(res).toEqual([1, null, 3]);
  });
});

describe('runWorkflow (script execution)', () => {
  it('runs 2 mock sub-agents in parallel and returns the script result', async () => {
    const calls: string[] = [];
    const deps = {
      agent: async (prompt: string) => {
        calls.push(prompt);
        return `answer:${prompt}`;
      },
    };
    const source = `
      const [a, b] = await parallel([
        () => agent('task-A'),
        () => agent('task-B'),
      ]);
      log('both done');
      return { a, b };
    `;
    const result = await runWorkflow(source, deps);
    expect(result).toEqual({ a: 'answer:task-A', b: 'answer:task-B' });
    expect(calls.sort()).toEqual(['task-A', 'task-B']);
  });

  it('exposes args and pipeline to the script', async () => {
    const deps = {
      agent: async (p: string) => p.toUpperCase(),
      args: ['x', 'y'],
    };
    const source = `
      return await pipeline(args, (item) => agent(item));
    `;
    const result = await runWorkflow(source, deps);
    expect(result).toEqual(['X', 'Y']);
  });

  it('respects the concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const deps = {
      maxConcurrent: 2,
      agent: async (p: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return p;
      },
    };
    const source = `return await parallel([1,2,3,4,5].map((n) => () => agent('t'+n)));`;
    await runWorkflow(source, deps);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('runWorkflowFile (the --workflow <file> path)', () => {
  it('loads and runs the shipped example script with mock sub-agents', async () => {
    const path = fileURLToPath(new URL('../examples/parallel-review.workflow.js', import.meta.url));
    const calls: string[] = [];
    const result = await runWorkflowFile(path, {
      agent: async (prompt: string) => {
        calls.push(prompt);
        return prompt.startsWith('Combine') ? 'FINAL SUMMARY' : 'risk bullets';
      },
      args: ['a.ts', 'b.ts', 'c.ts'],
    });
    expect(result).toBe('FINAL SUMMARY');
    // 3 per-file reviews (parallel) + 1 synthesis
    expect(calls.filter((c) => c.startsWith('Read')).length).toBe(3);
    expect(calls.filter((c) => c.startsWith('Combine')).length).toBe(1);
  });
});

describe('makeWorkflowAgent (real sub-agent backing)', () => {
  it('each agent() call spawns a fresh sub-agent through the loop', async () => {
    let n = 0;
    const agent = makeWorkflowAgent(() => createSession(baseConfig(answerProvider(`out${++n}`))));
    const source = `
      const first = await agent('one');
      const rest = await parallel([() => agent('two'), () => agent('three')]);
      return [first, ...rest];
    `;
    const result = (await runWorkflow(source, { agent })) as string[];
    // three distinct sub-agents → three distinct answers
    expect(new Set(result).size).toBe(3);
    expect(result.every((r) => r.startsWith('out'))).toBe(true);
  });
});
