/** Shared helpers for the built-in tools. */
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Expand a leading ~ and resolve relative paths against the tool cwd. */
export function resolvePath(cwd: string, p: string): string {
  let out = p;
  if (out === '~') out = homedir();
  else if (out.startsWith('~/')) out = resolve(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(cwd, out);
}

/** Read a required string field from a tool's parsed input, or throw. */
export function reqString(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string "${key}"`);
  }
  return v;
}

export function optString(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function optNumber(input: unknown, key: string): number | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function optBool(input: unknown, key: string): boolean | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

const MAX_OUTPUT = 60_000;

/** Cap tool output so a huge file/command can't blow up the context window. */
export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n… [truncated ${text.length - max} chars of ${text.length}]`;
}

/** Wrap a thrown error into an error ToolResult. */
export function errResult(e: unknown): { content: string; isError: true } {
  return { content: e instanceof Error ? e.message : String(e), isError: true };
}
