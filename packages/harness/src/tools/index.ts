/**
 * Built-in tools. OWNER: @providers.
 *
 *   read  — read a file (auto-allow)
 *   ls    — list a directory (auto-allow)
 *   glob  — match files by glob (auto-allow)
 *   grep  — search file contents (auto-allow)
 *   write — create/replace a file (GATED via ctx.permission)
 *   edit  — exact-string replace in a file (GATED)
 *   bash  — run a shell command (GATED)
 *
 * Each tool validates `input` and returns a ToolResult (errors come back as
 * { isError: true } rather than throwing, so the loop can feed them to the model).
 */
import type { Tool } from '../types.js';
import { globTool, grepTool, lsTool, readTool } from './read-tools.js';
import { bashTool, editTool, writeTool } from './write-tools.js';

export { globTool, grepTool, lsTool, readTool } from './read-tools.js';
export { bashTool, editTool, writeTool } from './write-tools.js';
export { createToolRegistry } from './registry.js';

/** All built-in tools, in a stable order (reads first, then mutating). */
export function builtinTools(): Tool[] {
  return [readTool, lsTool, globTool, grepTool, writeTool, editTool, bashTool];
}
