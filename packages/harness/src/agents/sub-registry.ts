/**
 * Sub-agent tool view. OWNER: @agents.
 *
 * A sub-agent must (a) see the SAME live toolset as the main session — including
 * tools that register after startup (MCP servers finishing their async connect,
 * the monitor/cron tools) — and (b) NOT see `spawn_agent`, so it can't recurse.
 *
 * The naive wiring (snapshot `registry.list()` into `createSession({ tools })`)
 * freezes a sub-agent's toolset at spawn time, so one spawned before MCP finishes
 * connecting never gets those tools. This returns a read-only *view* over the
 * shared registry that re-filters on every `list()`/`get()` — which the loop
 * calls each turn — so late arrivals show up mid-run, minus `spawn_agent`.
 */
import type { Tool, ToolRegistry } from '../types.js';

/**
 * Wrap a live registry so sub-agents see everything in it EXCEPT `exclude`
 * (default `spawn_agent`). Mutations delegate to the base (the loop never calls
 * them on a sub-session, but keeping the contract whole avoids surprises).
 */
export function subAgentRegistry(base: ToolRegistry, exclude = 'spawn_agent'): ToolRegistry {
  return {
    register: (t: Tool) => base.register(t),
    registerAll: (ts: readonly Tool[]) => base.registerAll(ts),
    unregister: (name: string) => base.unregister(name),
    list: () => base.list().filter((t) => t.spec.name !== exclude),
    get: (name: string) => (name === exclude ? undefined : base.get(name)),
  };
}
