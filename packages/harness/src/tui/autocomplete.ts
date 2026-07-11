/**
 * autocomplete.ts — non-intrusive input completion.
 *
 * Three sources, in priority order:
 *   1. slash commands  — when the line starts with `/` and the cursor is in the
 *      command word (`/mod` → `/model`).
 *   2. file paths      — a token starting with `@` or that looks path-like
 *      (`./`, `../`, `~/`, contains `/`); completed from the cwd.
 *   3. command history — plain prose that prefixes an earlier submission.
 *
 * Pure + deterministic: the directory lister is injected so tests never touch
 * the real filesystem. The App wires the real `fs` lister in.
 */
import { SLASH_COMMANDS } from './slash.js';

export type CompletionKind = 'slash' | 'file' | 'history';

export interface Completion {
  /** Full replacement text for the active token. */
  value: string;
  /** What to show in the menu. */
  label: string;
  hint?: string;
}

export interface CompletionResult {
  kind: CompletionKind;
  items: Completion[];
  /** Half-open range of the input replaced when an item is accepted. */
  replaceStart: number;
  replaceEnd: number;
}

/** Lists a directory's entries; directories MUST come back with a trailing `/`. */
export type DirLister = (dir: string) => string[];

export interface CompletionCtx {
  history: readonly string[];
  cwd: string;
  listDir: DirLister;
  /** Cap items per menu (default 8). */
  limit?: number;
}

const DEFAULT_LIMIT = 8;

/** Find the whitespace-delimited token that the cursor sits in. */
function tokenAt(input: string, cursor: number): { text: string; start: number; end: number } {
  let start = cursor;
  while (start > 0 && !/\s/.test(input[start - 1] as string)) start--;
  let end = cursor;
  while (end < input.length && !/\s/.test(input[end] as string)) end++;
  return { text: input.slice(start, end), start, end };
}

function slashCompletions(input: string): CompletionResult | null {
  // Only while typing the command word (no space committed yet).
  const m = /^(\/)([a-zA-Z?]*)$/.exec(input);
  if (!m) return null;
  const partial = (m[2] ?? '').toLowerCase();
  const items: Completion[] = [];
  for (const c of SLASH_COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])];
    const hit = names.find((n) => n.startsWith(partial));
    if (hit) {
      items.push({
        value: `/${c.name}${c.usage ? ' ' : ''}`,
        label: `/${c.name}${c.usage ? ' ' + c.usage : ''}`,
        hint: c.description,
      });
    }
  }
  return { kind: 'slash', items, replaceStart: 0, replaceEnd: input.length };
}

/** Split a partial path into the directory to list and the basename prefix. */
function splitPath(partial: string): { dir: string; base: string } {
  const slash = partial.lastIndexOf('/');
  if (slash === -1) return { dir: '.', base: partial };
  return { dir: partial.slice(0, slash + 1) || '/', base: partial.slice(slash + 1) };
}

function looksLikePath(tok: string): boolean {
  return (
    tok.startsWith('@') ||
    tok.startsWith('./') ||
    tok.startsWith('../') ||
    tok.startsWith('~/') ||
    tok.startsWith('/') ||
    tok.includes('/')
  );
}

function fileCompletions(input: string, cursor: number, ctx: CompletionCtx): CompletionResult | null {
  const { text, start, end } = tokenAt(input, cursor);
  if (!text || !looksLikePath(text)) return null;
  const at = text.startsWith('@');
  const raw = at ? text.slice(1) : text;
  const { dir, base } = splitPath(raw);
  let entries: string[];
  try {
    entries = ctx.listDir(resolveDir(dir, ctx.cwd));
  } catch {
    return null;
  }
  const prefix = raw.slice(0, raw.length - base.length); // the dir portion the user typed
  const items = entries
    .filter((e) => e.toLowerCase().startsWith(base.toLowerCase()))
    .slice(0, ctx.limit ?? DEFAULT_LIMIT)
    .map((e) => ({
      value: (at ? '@' : '') + prefix + e,
      label: prefix + e,
    }));
  if (items.length === 0) return null;
  return { kind: 'file', items, replaceStart: start, replaceEnd: end };
}

function resolveDir(dir: string, cwd: string): string {
  if (dir.startsWith('~')) return dir; // lister may expand; keep literal otherwise
  if (dir.startsWith('/')) return dir;
  return joinPosix(cwd, dir);
}

function joinPosix(a: string, b: string): string {
  if (b === '.' || b === './') return a;
  return (a.endsWith('/') ? a : a + '/') + b.replace(/^\.\//, '');
}

function historyCompletions(input: string, ctx: CompletionCtx): CompletionResult | null {
  if (!input || input.startsWith('/')) return null;
  const seen = new Set<string>();
  const items: Completion[] = [];
  // Newest first.
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const h = ctx.history[i] as string;
    if (h !== input && h.startsWith(input) && !seen.has(h)) {
      seen.add(h);
      items.push({ value: h, label: h, hint: 'history' });
      if (items.length >= (ctx.limit ?? DEFAULT_LIMIT)) break;
    }
  }
  if (items.length === 0) return null;
  return { kind: 'history', items, replaceStart: 0, replaceEnd: input.length };
}

/** Compute the active completion menu, or null when nothing applies. */
export function computeCompletions(
  input: string,
  cursor: number,
  ctx: CompletionCtx,
): CompletionResult | null {
  return (
    slashCompletions(input) ??
    fileCompletions(input, cursor, ctx) ??
    historyCompletions(input, ctx)
  );
}

/** Apply an accepted completion to the input, returning the new value + cursor. */
export function applyCompletion(
  input: string,
  result: CompletionResult,
  item: Completion,
): { value: string; cursor: number } {
  const value = input.slice(0, result.replaceStart) + item.value + input.slice(result.replaceEnd);
  return { value, cursor: result.replaceStart + item.value.length };
}
