/**
 * Background task runner units — exercise start/list/output/kill + subscriptions
 * against real short-lived bash processes. OWNER: @runtime.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner, type BgTask, type TaskRunner } from '../src/tasks/index.js';

/** Resolve once a task reaches a terminal state (or reject on timeout). */
function waitDone(runner: TaskRunner, id: string, ms = 5000): Promise<BgTask> {
  return new Promise((resolve, reject) => {
    const existing = runner.get(id);
    if (existing && existing.status !== 'running') return resolve(existing);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`task ${id} did not finish within ${ms}ms`));
    }, ms);
    const off = runner.onUpdate((t) => {
      if (t.id === id && t.status !== 'running') {
        clearTimeout(timer);
        off();
        resolve(t);
      }
    });
  });
}

let runner: TaskRunner;

afterEach(() => {
  runner?.killAll();
});

describe('task runner', () => {
  it('start returns immediately with a running snapshot', () => {
    runner = createTaskRunner();
    const t = runner.start('sleep 2');
    expect(t.id).toBe('bg1');
    expect(t.status).toBe('running');
    expect(t.exitCode).toBeNull();
    expect(t.endedAt).toBeNull();
    expect(runner.runningCount()).toBe(1);
  });

  it('captures output and exit code on success', async () => {
    runner = createTaskRunner();
    const t = runner.start('echo hello-bg');
    const done = await waitDone(runner, t.id);
    expect(done.status).toBe('exited');
    expect(done.exitCode).toBe(0);
    expect(runner.output(t.id)).toContain('hello-bg');
    expect(runner.runningCount()).toBe(0);
  });

  it('reports a non-zero exit code', async () => {
    runner = createTaskRunner();
    const t = runner.start('exit 3');
    const done = await waitDone(runner, t.id);
    expect(done.status).toBe('exited');
    expect(done.exitCode).toBe(3);
  });

  it('kill stops a running task and marks it killed', async () => {
    runner = createTaskRunner();
    const t = runner.start('sleep 30');
    expect(runner.kill(t.id)).toBe(true);
    const done = await waitDone(runner, t.id);
    expect(done.status).toBe('killed');
    expect(runner.runningCount()).toBe(0);
    // Killing an already-dead task is a no-op.
    expect(runner.kill(t.id)).toBe(false);
  });

  it('lists tasks oldest-first with independent ids', () => {
    runner = createTaskRunner();
    const a = runner.start('sleep 5');
    const b = runner.start('sleep 5');
    const ids = runner.list().map((t) => t.id);
    expect(ids).toEqual([a.id, b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it('notifies subscribers on updates and unsubscribes cleanly', async () => {
    runner = createTaskRunner();
    const seen: string[] = [];
    const off = runner.onUpdate((t) => seen.push(t.status));
    const t = runner.start('echo x');
    await waitDone(runner, t.id);
    expect(seen).toContain('exited');
    off();
    const before = seen.length;
    runner.start('echo y');
    // No new notifications after unsubscribe (give the event loop a tick).
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(before);
  });

  it('get/output return undefined/empty for unknown ids', () => {
    runner = createTaskRunner();
    expect(runner.get('nope')).toBeUndefined();
    expect(runner.output('nope')).toBe('');
  });

  // ── register(): in-process jobs (background sub-agents) — @core ──
  it('register runs an in-process job and captures its result as output', async () => {
    runner = createTaskRunner();
    const t = runner.register('sub-agent: do a thing', async () => 'the answer');
    expect(t.status).toBe('running');
    expect(t.id).toBe('bg1');
    expect(runner.runningCount()).toBe(1);
    const done = await waitDone(runner, t.id);
    expect(done.status).toBe('exited');
    expect(done.exitCode).toBe(0);
    expect(done.output).toBe('the answer');
    expect(runner.runningCount()).toBe(0);
  });

  it('register surfaces a thrown job as an error task', async () => {
    runner = createTaskRunner();
    const t = runner.register('flaky', async () => {
      throw new Error('boom');
    });
    const done = await waitDone(runner, t.id);
    expect(done.status).toBe('error');
    expect(done.output).toContain('boom');
  });

  it('kill aborts an in-process job via its AbortSignal', async () => {
    runner = createTaskRunner();
    const t = runner.register('long job', (signal) =>
      new Promise<string>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    expect(runner.kill(t.id)).toBe(true);
    const done = await waitDone(runner, t.id);
    // kill() marks it 'killed'; the job's rejection must NOT overwrite that.
    expect(done.status).toBe('killed');
  });
});
