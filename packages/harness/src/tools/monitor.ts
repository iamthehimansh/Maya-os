/**
 * File-monitor tool (item 12). OWNER: @tools.
 *
 * A stateful, model-callable tool that watches files/dirs for changes and
 * reports exactly what changed (size delta, mtime, appended lines). The model
 * uses it mid-task: `watch` a path to set a baseline, then `check` (compare
 * now vs. baseline) or `wait` (block until it changes, up to a timeout).
 *
 * State lives in a per-instance Map keyed by absolute path, so `check`/`wait`
 * report deltas relative to the last observation. No external deps; `wait`
 * uses `fs.watch` with a `stat`-poll fallback and honours `ctx.signal`.
 */
import { watch as fsWatch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { errResult, optNumber, optString, reqString, resolvePath, truncate } from './util.js';

/** A point-in-time observation of a path. `exists:false` records a missing file. */
interface Snapshot {
  exists: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  /** Line count for a readable text file; undefined for dirs/binary/unreadable. */
  lineCount?: number;
  /** Cached text (only when small enough to diff appended lines). */
  text?: string;
}

const MAX_DIFF_BYTES = 1_000_000; // don't hold text for files bigger than ~1 MB
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 300_000;

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const st = await stat(path);
    if (st.isDirectory()) {
      return { exists: true, isDir: true, size: st.size, mtimeMs: st.mtimeMs };
    }
    const snap: Snapshot = { exists: true, isDir: false, size: st.size, mtimeMs: st.mtimeMs };
    if (st.size <= MAX_DIFF_BYTES) {
      try {
        const text = await readFile(path, 'utf8');
        snap.text = text;
        snap.lineCount = text.length ? text.split('\n').length : 0;
      } catch {
        /* binary/unreadable — leave text/lineCount undefined */
      }
    }
    return snap;
  } catch {
    return { exists: false, isDir: false, size: 0, mtimeMs: 0 };
  }
}

/** Human-readable diff between two snapshots. Returns null when nothing changed. */
function describeChange(prev: Snapshot, cur: Snapshot): string | null {
  if (!prev.exists && !cur.exists) return null;
  if (prev.exists && !cur.exists) return 'deleted';
  if (!prev.exists && cur.exists) {
    return cur.isDir
      ? 'created (directory)'
      : `created (${cur.size} bytes${cur.lineCount !== undefined ? `, ${cur.lineCount} lines` : ''})`;
  }
  // Both exist.
  const parts: string[] = [];
  const sizeDelta = cur.size - prev.size;
  if (sizeDelta !== 0) parts.push(`size ${prev.size}→${cur.size} (${sizeDelta > 0 ? '+' : ''}${sizeDelta} bytes)`);
  if (cur.mtimeMs !== prev.mtimeMs) parts.push('mtime changed');

  // Appended lines: only when the file grew and we have both texts.
  if (
    !cur.isDir &&
    prev.text !== undefined &&
    cur.text !== undefined &&
    cur.text.startsWith(prev.text) &&
    cur.text.length > prev.text.length
  ) {
    const appended = cur.text.slice(prev.text.length);
    const lines = appended.split('\n').filter((l) => l.length > 0);
    if (lines.length) {
      parts.push(`+${lines.length} appended line${lines.length === 1 ? '' : 's'}:\n` + truncate(lines.map((l) => `  + ${l}`).join('\n'), 8_000));
    }
  } else if (
    !cur.isDir &&
    prev.lineCount !== undefined &&
    cur.lineCount !== undefined &&
    cur.lineCount !== prev.lineCount
  ) {
    // Content changed but not a clean append (rewrite/edit).
    const d = cur.lineCount - prev.lineCount;
    parts.push(`lines ${prev.lineCount}→${cur.lineCount} (${d > 0 ? '+' : ''}${d}, content rewritten)`);
  }

  if (parts.length === 0) return null;
  return parts.join('; ');
}

/** Wait for a path to change vs. `base`, up to `timeoutMs`. Resolves the new snapshot or null on timeout. */
function waitForChange(path: string, base: Snapshot, timeoutMs: number, signal?: AbortSignal): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: Snapshot | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* ignore */ }
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    const recheck = async () => {
      const cur = await snapshot(path);
      if (describeChange(base, cur) !== null) finish(cur);
    };

    // fs.watch fires on most changes; a slow poll catches creates/deletes and
    // platforms where watch misses events.
    let watcher: ReturnType<typeof fsWatch> | undefined;
    try {
      watcher = fsWatch(path, () => void recheck());
      watcher.on('error', () => { /* fall back to poll */ });
    } catch {
      /* path may not exist yet — poll handles it */
    }
    const poll = setInterval(() => void recheck(), 1000);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** A file-monitor with its own watch state. One per session; the model calls it repeatedly. */
export class FileMonitor {
  private readonly snaps = new Map<string, Snapshot>();

  /** For tests: forget all watched paths. */
  reset(): void {
    this.snaps.clear();
  }

  get tool(): Tool {
    return {
      spec: {
        name: 'file_monitor',
        description:
          'Watch files or directories for changes and report what changed (size, mtime, appended lines). ' +
          'Actions: "watch" records a baseline for a path; "check" reports what changed since the last observation ' +
          '(and updates the baseline); "wait" blocks until the path changes (up to timeoutMs) then reports it; ' +
          '"list" shows watched paths; "unwatch" stops watching. Use it mid-task to react to build output, logs, or generated files.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['watch', 'check', 'wait', 'list', 'unwatch'], description: 'What to do.' },
            path: { type: 'string', description: 'File or directory path (required for watch/check/wait/unwatch).' },
            timeoutMs: { type: 'number', description: 'For "wait": max ms to block (default 30000, max 300000).' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
      run: (input, ctx) => this.run(input, ctx),
    };
  }

  private async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const action = optString(input, 'action') ?? 'check';

      if (action === 'list') {
        if (this.snaps.size === 0) return { content: '(no paths are being watched)' };
        const lines = [...this.snaps.entries()].map(([p, s]) =>
          s.exists
            ? `${p} — ${s.isDir ? 'dir' : `${s.size} bytes${s.lineCount !== undefined ? `, ${s.lineCount} lines` : ''}`}`
            : `${p} — (absent)`,
        );
        return { content: lines.join('\n') };
      }

      const path = resolvePath(ctx.cwd, reqString(input, 'path'));

      if (action === 'unwatch') {
        const had = this.snaps.delete(path);
        return { content: had ? `Stopped watching ${path}.` : `${path} was not being watched.` };
      }

      if (action === 'watch') {
        const snap = await snapshot(path);
        this.snaps.set(path, snap);
        const state = snap.exists
          ? snap.isDir
            ? 'directory'
            : `${snap.size} bytes${snap.lineCount !== undefined ? `, ${snap.lineCount} lines` : ''}`
          : 'currently absent';
        return { content: `Watching ${path} (baseline: ${state}). Call check/wait to see changes.` };
      }

      if (action === 'check') {
        const prev = this.snaps.get(path);
        const cur = await snapshot(path);
        this.snaps.set(path, cur);
        if (!prev) {
          return { content: `No baseline for ${path} — recorded one now. Call check again after it changes.` };
        }
        const change = describeChange(prev, cur);
        return { content: change ? `${path}: ${change}` : `${path}: no change since last check.` };
      }

      if (action === 'wait') {
        const timeoutMs = Math.min(optNumber(input, 'timeoutMs') ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
        const base = this.snaps.get(path) ?? (await snapshot(path));
        if (!this.snaps.has(path)) this.snaps.set(path, base);
        // If it already changed vs. the baseline, report immediately.
        const immediate = await snapshot(path);
        const already = describeChange(base, immediate);
        if (already) {
          this.snaps.set(path, immediate);
          return { content: `${path}: ${already}` };
        }
        const changed = await waitForChange(path, base, timeoutMs, ctx.signal);
        if (!changed) {
          return { content: `${path}: no change within ${timeoutMs}ms.` };
        }
        this.snaps.set(path, changed);
        const change = describeChange(base, changed) ?? 'changed';
        return { content: `${path}: ${change}` };
      }

      return errResult(new Error(`unknown action "${action}"`));
    } catch (e) {
      return errResult(e);
    }
  }
}

/** A process-wide default instance for the built-in registry. */
export const defaultFileMonitor = new FileMonitor();
export const fileMonitorTool: Tool = defaultFileMonitor.tool;
