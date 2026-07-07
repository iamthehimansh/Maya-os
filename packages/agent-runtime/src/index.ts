/**
 * Maya agent runtime — adapter registry + built-in adapters.
 *
 * The platform (CLI, orchestrator, dashboard) talks to agents ONLY through
 * this surface (contracts/agents.ts); each adapter translates to its tool's
 * real CLI underneath.
 */

import type { AgentAdapter, AgentHandle, AgentSpawnSpec } from '@maya-ai/core';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from './adapters/claude-code.js';

export { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from './adapters/claude-code.js';
export { EventLog } from './events.js';

export interface AgentRuntimeOptions {
  /** Maya gateway base — every agent's model routes through it. */
  gatewayBaseUrl: string;
}

export class AgentRuntime {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(opts: AgentRuntimeOptions) {
    this.register(new ClaudeCodeAdapter({ gatewayBaseUrl: opts.gatewayBaseUrl }));
    // codex + opencode adapters land next on the same interface.
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  adapter(id: string): AgentAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}" (known: ${[...this.adapters.keys()].join(', ')})`);
    return a;
  }

  adapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    return this.adapter(spec.adapter).spawn(spec);
  }
}
