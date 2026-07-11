/**
 * File-monitor tool (item 12) — watch a real temp file, mutate it, and assert
 * the tool reports size/mtime/appended-line changes. `wait` is exercised
 * against a live append and a timeout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMonitor } from '../src/tools/monitor.js';
import type { PermissionGate, PermissionRequest, ToolContext } from '../src/types.js';

class AllowGate implements PermissionGate {
  readonly seen: PermissionRequest[] = [];
  async request(req: PermissionRequest): Promise<boolean> {
    this.seen.push(req);
    return true;
  }
}

let dir: string;
let gate: AllowGate;
let ctx: ToolContext;
let monitor: FileMonitor;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-monitor-'));
  gate = new AllowGate();
  ctx = { cwd: dir, permission: gate };
  monitor = new FileMonitor();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file_monitor tool', () => {
  it('never asks permission (read-only)', async () => {
    await writeFile(join(dir, 'log.txt'), 'a\n');
    await monitor.tool.run({ action: 'watch', path: 'log.txt' }, ctx);
    await monitor.tool.run({ action: 'check', path: 'log.txt' }, ctx);
    expect(gate.seen).toHaveLength(0);
  });

  it('watch → check reports appended lines', async () => {
    const p = join(dir, 'log.txt');
    await writeFile(p, 'line1\n');
    const w = await monitor.tool.run({ action: 'watch', path: 'log.txt' }, ctx);
    expect(w.content).toContain('Watching');
    expect(w.content).toContain('2 lines');

    await appendFile(p, 'line2\nline3\n');
    const c = await monitor.tool.run({ action: 'check', path: 'log.txt' }, ctx);
    expect(c.content).toContain('+2 appended lines');
    expect(c.content).toContain('line2');
    expect(c.content).toContain('line3');
    expect(c.content).toMatch(/size 6→18/);
  });

  it('check with no baseline records one, then no-change on the next check', async () => {
    const p = join(dir, 'x.txt');
    await writeFile(p, 'hello');
    const first = await monitor.tool.run({ action: 'check', path: 'x.txt' }, ctx);
    expect(first.content).toContain('No baseline');
    const second = await monitor.tool.run({ action: 'check', path: 'x.txt' }, ctx);
    expect(second.content).toContain('no change');
  });

  it('reports creation and deletion', async () => {
    const p = join(dir, 'later.txt');
    const w = await monitor.tool.run({ action: 'watch', path: 'later.txt' }, ctx);
    expect(w.content).toContain('absent');
    await writeFile(p, 'now here\n');
    const created = await monitor.tool.run({ action: 'check', path: 'later.txt' }, ctx);
    expect(created.content).toContain('created');
    await unlink(p);
    const deleted = await monitor.tool.run({ action: 'check', path: 'later.txt' }, ctx);
    expect(deleted.content).toContain('deleted');
  });

  it('wait resolves when the file changes', async () => {
    const p = join(dir, 'live.txt');
    await writeFile(p, 'start\n');
    await monitor.tool.run({ action: 'watch', path: 'live.txt' }, ctx);
    // Append shortly after we start waiting.
    setTimeout(() => void appendFile(p, 'more\n'), 150);
    const res = await monitor.tool.run({ action: 'wait', path: 'live.txt', timeoutMs: 5000 }, ctx);
    expect(res.content).toContain('live.txt');
    expect(res.content).toMatch(/appended|size/);
  });

  it('wait times out cleanly when nothing changes', async () => {
    const p = join(dir, 'still.txt');
    await writeFile(p, 'quiet\n');
    await monitor.tool.run({ action: 'watch', path: 'still.txt' }, ctx);
    const res = await monitor.tool.run({ action: 'wait', path: 'still.txt', timeoutMs: 300 }, ctx);
    expect(res.content).toContain('no change within');
  });

  it('list and unwatch manage the watch set', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    await monitor.tool.run({ action: 'watch', path: 'a.txt' }, ctx);
    const listed = await monitor.tool.run({ action: 'list' }, ctx);
    expect(listed.content).toContain('a.txt');
    const un = await monitor.tool.run({ action: 'unwatch', path: 'a.txt' }, ctx);
    expect(un.content).toContain('Stopped watching');
    const empty = await monitor.tool.run({ action: 'list' }, ctx);
    expect(empty.content).toContain('no paths');
  });
});
