/**
 * Tasks agent tool (list/kill) — drives the model-facing `tasks` tool against a
 * real TaskRunner, proving it lists jobs, kills a running one, and degrades when
 * no runner is wired. OWNER: @tools.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tasksTool } from '../src/tools/tasks-tool.js';
import { createTaskRunner, type TaskRunner } from '../src/tasks/index.js';
import type { ToolContext } from '../src/types.js';

let runner: TaskRunner;
afterEach(() => runner?.killAll());

function ctx(tasks?: TaskRunner): ToolContext {
  return { cwd: process.cwd(), permission: { async request() { return true; } }, ...(tasks ? { tasks } : {}) } as ToolContext;
}

describe('tasks tool', () => {
  it('has the expected model-facing spec', () => {
    expect(tasksTool.spec.name).toBe('tasks');
    const props = tasksTool.spec.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['action', 'id']);
  });

  it('lists background tasks with status + command', async () => {
    runner = createTaskRunner();
    runner.start('sleep 5');
    const res = await tasksTool.run({ action: 'list' }, ctx(runner));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('bg1');
    expect(res.content).toContain('running');
    expect(res.content).toContain('sleep 5');
  });

  it('reports an empty list cleanly', async () => {
    runner = createTaskRunner();
    const res = await tasksTool.run({ action: 'list' }, ctx(runner));
    expect(res.content).toContain('no background tasks');
  });

  it('kills a running task by id', async () => {
    runner = createTaskRunner();
    const t = runner.start('sleep 30');
    const res = await tasksTool.run({ action: 'kill', id: t.id }, ctx(runner));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(`Killed ${t.id}`);
    expect(runner.get(t.id)!.status).toBe('killed');
  });

  it('errors on an unknown id', async () => {
    runner = createTaskRunner();
    const res = await tasksTool.run({ action: 'kill', id: 'bg999' }, ctx(runner));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('No task with id');
  });

  it('reports when a task is already finished (no kill)', async () => {
    runner = createTaskRunner();
    const t = runner.start('true');
    // Give the short command a tick to exit.
    await new Promise((r) => setTimeout(r, 300));
    const res = await tasksTool.run({ action: 'kill', id: t.id }, ctx(runner));
    expect(res.content).toContain('not running');
  });

  it('degrades gracefully when no runner is present', async () => {
    const res = await tasksTool.run({ action: 'list' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('No background task runner');
  });
});
