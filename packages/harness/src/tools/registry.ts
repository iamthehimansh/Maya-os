/**
 * Dynamic tool registry. OWNER: @core.
 *
 * A live, mutable set of tools the loop reads on EVERY turn — so tools that
 * arrive after startup (MCP servers connecting, sub-agents being spawned, the
 * monitor/cron tools) are picked up without rebuilding the session. Dedup is by
 * `spec.name`, keeping a stable insertion order; a later register() of the same
 * name replaces the earlier tool in place (so an MCP reconnect swaps cleanly).
 */
import type { Tool, ToolRegistry } from '../types.js';

class ToolRegistryImpl implements ToolRegistry {
  /** name → tool, insertion-ordered (Map preserves first-insert order). */
  private readonly tools = new Map<string, Tool>();

  constructor(initial: readonly Tool[] = []) {
    this.registerAll(initial);
  }

  register(tool: Tool): void {
    // Replacing in place keeps the original slot order; a brand-new name appends.
    this.tools.set(tool.spec.name, tool);
  }

  registerAll(tools: readonly Tool[]): void {
    for (const t of tools) this.register(t);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

export function createToolRegistry(initial?: readonly Tool[]): ToolRegistry {
  return new ToolRegistryImpl(initial);
}
