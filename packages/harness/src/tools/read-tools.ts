/**
 * Read-only tools: read, ls, glob, grep. These are auto-allowed — they never
 * call ctx.permission (nothing they do mutates state).
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { glob as fsGlob } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { errResult, optNumber, optString, reqString, resolvePath, truncate } from './util.js';

const IGNORE_DIRS = ['node_modules', '.git', 'dist', '.next', 'build', 'coverage'];

export const readTool: Tool = {
  spec: {
    name: 'read',
    description:
      'Read a UTF-8 text file. Optionally start at a 1-based line offset and cap the number of lines. Returns the file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to cwd or absolute; ~ allowed).' },
        offset: { type: 'number', description: '1-based line to start from.' },
        limit: { type: 'number', description: 'Max number of lines to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const path = resolvePath(ctx.cwd, reqString(input, 'path'));
      const raw = await readFile(path, 'utf8');
      const offset = optNumber(input, 'offset');
      const limit = optNumber(input, 'limit');
      if (offset === undefined && limit === undefined) return { content: truncate(raw) };
      const lines = raw.split('\n');
      const start = offset && offset > 0 ? offset - 1 : 0;
      const end = limit && limit > 0 ? start + limit : lines.length;
      return { content: truncate(lines.slice(start, end).join('\n')) };
    } catch (e) {
      return errResult(e);
    }
  },
};

export const lsTool: Tool = {
  spec: {
    name: 'ls',
    description: 'List the entries of a directory, marking sub-directories with a trailing slash.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (defaults to cwd).' },
      },
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const dir = resolvePath(ctx.cwd, optString(input, 'path') ?? '.');
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
      return { content: lines.length ? truncate(lines.join('\n')) : '(empty directory)' };
    } catch (e) {
      return errResult(e);
    }
  },
};

export const globTool: Tool = {
  spec: {
    name: 'glob',
    description:
      'Find files matching a glob pattern (e.g. "src/**/*.ts"). Skips node_modules/.git/dist. Returns matching paths relative to cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: 'Base directory to search from (defaults to cwd).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const pattern = reqString(input, 'pattern');
      const base = resolvePath(ctx.cwd, optString(input, 'path') ?? '.');
      const out: string[] = [];
      for await (const entry of fsGlob(pattern, { cwd: base })) {
        const rel = typeof entry === 'string' ? entry : String(entry);
        if (IGNORE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`) || rel.includes(`/${d}/`))) {
          continue;
        }
        out.push(rel);
        if (out.length >= 1000) break;
      }
      out.sort((a, b) => a.localeCompare(b));
      return { content: out.length ? truncate(out.join('\n')) : '(no matches)' };
    } catch (e) {
      return errResult(e);
    }
  },
};

/** Whether ripgrep is on PATH (checked once, lazily). */
let rgAvailable: boolean | undefined;
function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) return Promise.resolve(rgAvailable);
  return new Promise((res) => {
    execFile('rg', ['--version'], { timeout: 5000 }, (err) => {
      rgAvailable = !err;
      res(rgAvailable);
    });
  });
}

function rgSearch(pattern: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((res) => {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '200'];
    for (const d of IGNORE_DIRS) args.push('--glob', `!${d}`);
    args.push(pattern);
    execFile(
      'rg',
      args,
      { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (err, stdout) => {
        // rg exits 1 when there are simply no matches — not an error for us.
        if (err && (err as NodeJS.ErrnoException).code === undefined && !stdout) return res('(no matches)');
        res(stdout && stdout.length ? stdout : '(no matches)');
      },
    );
  });
}

/** Pure-JS fallback grep when ripgrep isn't installed. */
async function jsSearch(pattern: string, cwd: string): Promise<string> {
  const re = new RegExp(pattern);
  const hits: string[] = [];
  for await (const entry of fsGlob('**/*', { cwd })) {
    const rel = typeof entry === 'string' ? entry : String(entry);
    if (IGNORE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`) || rel.includes(`/${d}/`))) continue;
    const abs = join(cwd, rel);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const text = await readFile(abs, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${relative(cwd, abs)}:${i + 1}:${lines[i]}`);
          if (hits.length >= 200) return hits.join('\n');
        }
      }
    } catch {
      /* skip unreadable/binary */
    }
  }
  return hits.length ? hits.join('\n') : '(no matches)';
}

export const grepTool: Tool = {
  spec: {
    name: 'grep',
    description:
      'Search file contents by regular expression across the tree (skips node_modules/.git/dist). Returns file:line:match lines. Uses ripgrep when available.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search in (defaults to cwd).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const pattern = reqString(input, 'pattern');
      const dir = resolvePath(ctx.cwd, optString(input, 'path') ?? '.');
      const out = (await hasRipgrep())
        ? await rgSearch(pattern, dir, ctx.signal)
        : await jsSearch(pattern, dir);
      return { content: truncate(out) };
    } catch (e) {
      return errResult(e);
    }
  },
};
