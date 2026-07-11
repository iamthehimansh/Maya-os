/**
 * Memory — global + per-project knowledge, à la Claude Code's CLAUDE.md.
 * OWNER: @context.
 *
 * Two sources, both plain Markdown the user (or the agent) writes:
 *   • GLOBAL  — `~/.mayac/MAYAC.md` plus every `*.md` under `~/.mayac/memory/`.
 *              Loaded into every session regardless of cwd.
 *   • PROJECT — a `MAYAC.md` (and `.mayac/MAYAC.md`) discovered by walking from
 *              the cwd UPWARD to the filesystem root (like CLAUDE.md). Nearer
 *              files win — they render last so they can override ancestors.
 *
 * The loaded text is folded into the system prompt by `src/context`. `/memory`
 * views it and the agent can append a note via `appendMemory`.
 *
 * SECURITY: we only ever read the designated memory files (`MAYAC.md` and
 * markdown under `.mayac/`/`memory/`). We never read arbitrary project files,
 * never `.env`, never anything outside those names — so secrets don't leak in.
 * No Ink/React deps; consumed by the context manager and the TUI, tested standalone.
 */
import { mkdir, readFile, readdir, appendFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse as parsePath } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';

/** One loaded memory file. */
export interface MemoryFile {
  /** 'global' | 'project'. */
  scope: 'global' | 'project';
  /** Absolute path on disk. */
  path: string;
  /** File contents (trimmed). */
  content: string;
}

export interface LoadedMemory {
  files: MemoryFile[];
  /** Approximate character count of all loaded memory (for the meter/`/memory`). */
  chars: number;
}

export const GLOBAL_DIR = join(homedir(), '.mayac');
export const GLOBAL_FILE = join(GLOBAL_DIR, 'MAYAC.md');
export const GLOBAL_MEMORY_DIR = join(GLOBAL_DIR, 'memory');
/** The per-project memory filename discovered up the tree. */
export const PROJECT_FILE = 'MAYAC.md';

/** Cap per file so one runaway note can't blow the context budget. */
const MAX_FILE_CHARS = 24_000;

async function readIfPresent(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_FILE_CHARS
      ? `${trimmed.slice(0, MAX_FILE_CHARS)}\n…[memory file truncated]`
      : trimmed;
  } catch {
    return null;
  }
}

/** Every `*.md` in a directory, sorted, each read. Missing dir → []. */
async function readMarkdownDir(dir: string, scope: MemoryFile['scope']): Promise<MemoryFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: MemoryFile[] = [];
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
    const path = join(dir, name);
    const content = await readIfPresent(path);
    if (content) out.push({ scope, path, content });
  }
  return out;
}

/** Global memory: `~/.mayac/MAYAC.md` then `~/.mayac/memory/*.md`. */
export async function loadGlobalMemory(baseDir: string = GLOBAL_DIR): Promise<MemoryFile[]> {
  const out: MemoryFile[] = [];
  const main = await readIfPresent(join(baseDir, 'MAYAC.md'));
  if (main) out.push({ scope: 'global', path: join(baseDir, 'MAYAC.md'), content: main });
  out.push(...(await readMarkdownDir(join(baseDir, 'memory'), 'global')));
  return out;
}

/**
 * Project memory discovered by walking from `cwd` up to the filesystem root.
 * At each ancestor we look for `MAYAC.md` and `.mayac/MAYAC.md`. Results are
 * ordered OUTERMOST → INNERMOST so the nearest (most specific) file renders last.
 */
export async function loadProjectMemory(cwd: string): Promise<MemoryFile[]> {
  const chain: string[] = [];
  let dir = cwd;
  const root = parsePath(dir).root;
  // Guard against symlink loops / absurd depth.
  for (let i = 0; i < 64; i++) {
    chain.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Walk innermost→outermost while reading, then reverse so outermost renders first.
  const found: MemoryFile[] = [];
  for (const d of chain) {
    for (const candidate of [join(d, PROJECT_FILE), join(d, '.mayac', 'MAYAC.md')]) {
      const content = await readIfPresent(candidate);
      if (content) found.push({ scope: 'project', path: candidate, content });
    }
  }
  return found.reverse();
}

/** Load global + project memory for a session rooted at `cwd`. */
export async function loadMemory(
  cwd: string,
  opts: { globalDir?: string } = {},
): Promise<LoadedMemory> {
  const [global, project] = await Promise.all([
    loadGlobalMemory(opts.globalDir),
    loadProjectMemory(cwd),
  ]);
  const files = [...global, ...project];
  const chars = files.reduce((n, f) => n + f.content.length, 0);
  return { files, chars };
}

/**
 * Render loaded memory into a system-prompt section. Empty memory → ''.
 * Each file is labeled by scope + a short path so the model knows its provenance.
 */
export function renderMemory(loaded: LoadedMemory): string {
  if (loaded.files.length === 0) return '';
  const parts: string[] = [
    '# Memory',
    'Persistent knowledge for this session (global + project). Treat it as standing guidance from the user.',
  ];
  for (const f of loaded.files) {
    const label = f.scope === 'global' ? 'global' : 'project';
    parts.push(`\n## ${label}: ${shortenPath(f.path)}\n${f.content}`);
  }
  return parts.join('\n');
}

/** Home-relative, compact path for labels (`~/.mayac/MAYAC.md`). */
export function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Append a note to memory. `scope: 'global'` → `~/.mayac/MAYAC.md`;
 * `scope: 'project'` → `<cwd>/MAYAC.md`. Creates the file (with a header) if
 * absent. Returns the file path written. Used by `/memory add` and the agent's
 * `remember` tool.
 */
export async function appendMemory(
  scope: 'global' | 'project',
  note: string,
  opts: { cwd?: string; globalDir?: string } = {},
): Promise<string> {
  const trimmed = note.trim();
  if (!trimmed) throw new Error('Cannot append empty memory note.');
  const path =
    scope === 'global'
      ? join(opts.globalDir ?? GLOBAL_DIR, 'MAYAC.md')
      : join(opts.cwd ?? process.cwd(), PROJECT_FILE);
  await mkdir(dirname(path), { recursive: true });
  let raw: string | null;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null || raw.trim() === '') {
    const header =
      scope === 'global'
        ? '# Maya code — global memory\n\nStanding notes loaded into every session.\n'
        : '# Maya code — project memory\n\nStanding notes for this project.\n';
    await writeFile(path, `${header}\n- ${trimmed}\n`, 'utf8');
  } else {
    // Append the bullet, guaranteeing exactly one newline before it.
    const sep = raw.endsWith('\n') ? '' : '\n';
    await appendFile(path, `${sep}- ${trimmed}\n`, 'utf8');
  }
  return path;
}

/**
 * Edit memory in place with a SAFE find→replace — the agent's `memory edit` and
 * `/memory edit <old> => <new>`. Reads the target file (project `<cwd>/MAYAC.md`
 * or global `~/.mayac/MAYAC.md`), replaces the FIRST occurrence of `find` with
 * `replace`, and writes it back. Never clobbers blindly:
 *   • empty `find` → rejected (would match everywhere);
 *   • `find` not present → throws (so the agent knows its edit didn't apply);
 *   • missing file → throws (nothing to edit yet — use add first).
 * Returns the file path written. Only ever touches the dedicated MAYAC.md, so no
 * arbitrary file (or secret) is reachable through it.
 */
export async function editMemory(
  scope: 'global' | 'project',
  find: string,
  replace: string,
  opts: { cwd?: string; globalDir?: string } = {},
): Promise<string> {
  if (!find) throw new Error('Cannot edit memory with an empty "find" string.');
  const path =
    scope === 'global'
      ? join(opts.globalDir ?? GLOBAL_DIR, 'MAYAC.md')
      : join(opts.cwd ?? process.cwd(), PROJECT_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No ${scope} memory file to edit at ${shortenPath(path)}. Add a note first.`);
  }
  const idx = raw.indexOf(find);
  if (idx === -1) {
    throw new Error(`Text to replace not found in ${scope} memory (${shortenPath(path)}).`);
  }
  const updated = raw.slice(0, idx) + replace + raw.slice(idx + find.length);
  await writeFile(path, updated, 'utf8');
  return path;
}

/**
 * Human-readable summary of loaded memory for the `/memory` command. Lists each
 * source file with scope, home-relative path, and size; explains where to edit.
 */
export function formatMemoryView(loaded: LoadedMemory): string {
  const lines: string[] = ['Memory — persistent knowledge loaded into this session.'];
  if (loaded.files.length === 0) {
    lines.push('');
    lines.push('(none loaded)');
    lines.push('');
    lines.push(`Add project memory:  ${PROJECT_FILE} in this project`);
    lines.push(`Add global memory:   ${shortenPath(GLOBAL_FILE)}`);
    lines.push('Or run  /memory add <note>  ·  the agent can also use the `remember` tool.');
    return lines.join('\n');
  }
  for (const f of loaded.files) {
    const kb = (f.content.length / 1024).toFixed(1);
    lines.push(`  ${f.scope === 'global' ? '🌐' : '📁'} ${f.scope.padEnd(7)} ${shortenPath(f.path)}  (${kb} KB)`);
  }
  lines.push('');
  lines.push(`Total: ${loaded.files.length} file(s), ~${loaded.chars} chars.`);
  lines.push('Edit those files directly, or  /memory add <note>  to append.');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────── remember tool ────

/**
 * `remember` — lets the agent persist a durable note to memory mid-task, so it
 * survives future sessions (like Claude Code writing to CLAUDE.md). Defaults to
 * project scope. Auto-allowed: it only ever appends to the dedicated MAYAC.md.
 */
export const rememberTool: Tool = {
  spec: {
    name: 'remember',
    description:
      'Save a durable note to memory so it is available in future sessions. Use for ' +
      'standing facts, conventions, or decisions worth persisting — NOT secrets or ' +
      'transient details. Defaults to project memory (<cwd>/MAYAC.md); pass scope ' +
      '"global" for machine-wide notes (~/.mayac/MAYAC.md).',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The note to remember (one concise fact or convention).' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'project (default) or global.' },
      },
      required: ['note'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const rec = (input ?? {}) as Record<string, unknown>;
    const note = typeof rec.note === 'string' ? rec.note.trim() : '';
    if (!note) return { content: 'missing required string "note"', isError: true };
    const scope = rec.scope === 'global' ? 'global' : 'project';
    try {
      const path = await appendMemory(scope, note, { cwd: ctx.cwd });
      return { content: `Saved to ${scope} memory (${shortenPath(path)}).` };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  },
};

// ──────────────────────────────────────────────────────── memory tool ────────

/**
 * `memory` — full agent-side access to persistent memory, mirroring what
 * `/memory` gives the user but callable by the model mid-task:
 *   • view — read the currently loaded global + project memory (fresh from disk,
 *            so the agent sees its own add/edit immediately);
 *   • add  — append a durable note (same as `remember`);
 *   • edit — SAFE find→replace on an existing entry/section (never clobbers).
 * Only ever reads/writes the designated MAYAC.md files, so no secret can leak in.
 * `remember` stays for back-compat; this is the richer surface.
 */
export const memoryTool: Tool = {
  spec: {
    name: 'memory',
    description:
      'View, add to, or edit your persistent memory (global + per-project MAYAC.md, ' +
      'loaded into every session). action="view" reads the current memory; ' +
      'action="add" appends a note (like remember); action="edit" does a safe ' +
      'find→replace on an existing entry (fails if the text is not found — never ' +
      'clobbers). scope is "project" (default, <cwd>/MAYAC.md) or "global" ' +
      '(~/.mayac/MAYAC.md). Persist standing facts/conventions — never secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['view', 'add', 'edit'], description: 'view | add | edit' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'project (default) or global' },
        note: { type: 'string', description: 'For action="add": the note to append.' },
        find: { type: 'string', description: 'For action="edit": exact existing text to replace.' },
        replace: { type: 'string', description: 'For action="edit": text to put in place of `find`.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const rec = (input ?? {}) as Record<string, unknown>;
    const action = typeof rec.action === 'string' ? rec.action : '';
    const scope = rec.scope === 'global' ? 'global' : 'project';
    try {
      if (action === 'view') {
        // Fresh from disk so the agent sees its own add/edit immediately. Return
        // the actual memory CONTENT (what's folded into the system prompt), with a
        // short listing footer so provenance is clear.
        const loaded = await loadMemory(ctx.cwd);
        const rendered = renderMemory(loaded);
        const listing = formatMemoryView(loaded);
        const body = rendered ? `${rendered}\n\n---\n${listing}` : listing;
        return { content: body };
      }
      if (action === 'add') {
        const note = typeof rec.note === 'string' ? rec.note.trim() : '';
        if (!note) return { content: 'action="add" requires a non-empty "note".', isError: true };
        const path = await appendMemory(scope, note, { cwd: ctx.cwd });
        return { content: `Saved to ${scope} memory (${shortenPath(path)}).` };
      }
      if (action === 'edit') {
        const find = typeof rec.find === 'string' ? rec.find : '';
        const replace = typeof rec.replace === 'string' ? rec.replace : '';
        if (!find) return { content: 'action="edit" requires a non-empty "find".', isError: true };
        const path = await editMemory(scope, find, replace, { cwd: ctx.cwd });
        return { content: `Edited ${scope} memory (${shortenPath(path)}).` };
      }
      return { content: `Unknown action "${action}". Use view | add | edit.`, isError: true };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  },
};
