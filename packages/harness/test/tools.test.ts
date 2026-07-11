/**
 * Built-in tool units — exercise each tool against a real temp dir with a
 * scripted permission gate (asserting reads never gate and mutating tools do).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinTools } from '../src/tools/index.js';
import { bashTool, editTool, globTool, grepTool, lsTool, readTool, writeTool } from '../src/tools/index.js';
import { createTaskRunner } from '../src/tasks/index.js';
import type { PermissionGate, PermissionRequest, ToolContext } from '../src/types.js';

/** Records every permission request and answers with a fixed verdict. */
class RecordingGate implements PermissionGate {
  readonly seen: PermissionRequest[] = [];
  constructor(private readonly verdict: boolean) {}
  async request(req: PermissionRequest): Promise<boolean> {
    this.seen.push(req);
    return this.verdict;
  }
}

let dir: string;
let gate: RecordingGate;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  gate = new RecordingGate(true);
  ctx = { cwd: dir, permission: gate };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('builtinTools', () => {
  it('exposes all 7 in a stable order', () => {
    expect(builtinTools().map((t) => t.spec.name)).toEqual([
      'read', 'ls', 'glob', 'grep', 'write', 'edit', 'bash',
    ]);
  });
});

describe('read-only tools never gate', () => {
  it('read returns file content and honours offset/limit', async () => {
    await writeFile(join(dir, 'f.txt'), 'l1\nl2\nl3\nl4');
    const all = await readTool.run({ path: 'f.txt' }, ctx);
    expect(all.content).toBe('l1\nl2\nl3\nl4');
    const slice = await readTool.run({ path: 'f.txt', offset: 2, limit: 2 }, ctx);
    expect(slice.content).toBe('l2\nl3');
    expect(gate.seen).toHaveLength(0);
  });

  it('read reports a missing file as an error result, not a throw', async () => {
    const r = await readTool.run({ path: 'nope.txt' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('ls lists entries and marks directories', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    await (await import('node:fs/promises')).mkdir(join(dir, 'sub'));
    const r = await lsTool.run({}, ctx);
    expect(r.content).toContain('a.txt');
    expect(r.content).toContain('sub/');
  });

  it('glob matches by pattern and skips ignored dirs', async () => {
    await writeFile(join(dir, 'a.ts'), 'x');
    await writeFile(join(dir, 'b.ts'), 'x');
    const r = await globTool.run({ pattern: '*.ts' }, ctx);
    expect(r.content.split('\n').sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('grep finds matching lines', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello\nNEEDLE here\nbye');
    const r = await grepTool.run({ pattern: 'NEEDLE' }, ctx);
    expect(r.content).toContain('NEEDLE');
  });
});

describe('mutating tools gate on permission', () => {
  it('write creates a file when allowed', async () => {
    const r = await writeTool.run({ path: 'out.txt', content: 'hi there' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('hi there');
    expect(gate.seen[0]!.tool).toBe('write');
  });

  it('write does nothing when denied', async () => {
    const deny = new RecordingGate(false);
    const r = await writeTool.run({ path: 'out.txt', content: 'hi' }, { cwd: dir, permission: deny });
    expect(r.isError).toBe(true);
    await expect(readFile(join(dir, 'out.txt'), 'utf8')).rejects.toThrow();
  });

  it('edit replaces an exact unique string', async () => {
    await writeFile(join(dir, 'e.txt'), 'const a = 1;');
    const r = await editTool.run({ path: 'e.txt', old_string: 'a = 1', new_string: 'a = 2' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(await readFile(join(dir, 'e.txt'), 'utf8')).toBe('const a = 2;');
  });

  it('edit refuses a non-unique string without replace_all', async () => {
    await writeFile(join(dir, 'e.txt'), 'x x x');
    const r = await editTool.run({ path: 'e.txt', old_string: 'x', new_string: 'y' }, ctx);
    expect(r.isError).toBe(true);
    // replace_all makes it succeed
    const r2 = await editTool.run({ path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(await readFile(join(dir, 'e.txt'), 'utf8')).toBe('y y y');
  });

  it('edit errors when old_string is absent', async () => {
    await writeFile(join(dir, 'e.txt'), 'abc');
    const r = await editTool.run({ path: 'e.txt', old_string: 'zzz', new_string: 'q' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('bash runs a command and captures output + exit code', async () => {
    const r = await bashTool.run({ command: 'echo hello && exit 0' }, ctx);
    expect(r.content).toContain('hello');
    expect(r.content).toContain('exit 0');
    expect(gate.seen[0]!.tool).toBe('bash');
  });

  it('bash marks a non-zero exit as an error', async () => {
    const r = await bashTool.run({ command: 'exit 3' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('exit 3');
  });

  it('bash does not run when denied', async () => {
    const deny = new RecordingGate(false);
    const marker = join(dir, 'ran.txt');
    const r = await bashTool.run({ command: `touch ${marker}` }, { cwd: dir, permission: deny });
    expect(r.isError).toBe(true);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});

describe('bash background (agent-driven, fix #3)', () => {
  it('background:true returns a task handle synchronously and registers a live task', async () => {
    const runner = createTaskRunner(dir);
    // A command that outlives the tool call so it is provably still "running".
    const r = await bashTool.run(
      { command: 'sleep 2 && echo done', background: true },
      { cwd: dir, permission: gate, tasks: runner },
    );

    // Returned immediately with a handle rather than the command's output.
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('background');
    expect(r.content).toContain('bg1');

    // The task is registered and — since the command sleeps 2s but the tool
    // already returned — provably still running (i.e. we did NOT block on it).
    const tasks = runner.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('bg1');
    expect(tasks[0]!.command).toBe('sleep 2 && echo done');
    expect(tasks[0]!.status).toBe('running');
    expect(runner.runningCount()).toBe(1);

    // Permission was requested and flagged as a background run.
    expect(gate.seen[0]!.tool).toBe('bash');
    expect(gate.seen[0]!.summary).toContain('background');

    runner.killAll();
  });

  it('background:true falls back to synchronous run when no runner is wired', async () => {
    const r = await bashTool.run(
      { command: 'echo inline && exit 0', background: true },
      { cwd: dir, permission: gate },
    );
    // No runner → behaves like a normal blocking run and returns the output.
    expect(r.content).toContain('inline');
    expect(r.content).toContain('exit 0');
  });

  it('background:false runs to completion as before', async () => {
    const runner = createTaskRunner(dir);
    const r = await bashTool.run(
      { command: 'echo sync', background: false },
      { cwd: dir, permission: gate, tasks: runner },
    );
    expect(r.content).toContain('sync');
    expect(runner.list()).toHaveLength(0); // never touched the runner
  });
});
