/**
 * Maya agent runtime — adapter registry + built-in adapters.
 *
 * The platform (CLI, orchestrator, dashboard) talks to agents ONLY through
 * this surface (contracts/agents.ts); each adapter translates to its tool's
 * real CLI underneath.
 */

import type { AgentAdapter, AgentHandle, AgentSpawnSpec } from '@maya-ai/core';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from './adapters/claude-code.js';
import { CodexAdapter, type CodexAdapterOptions } from './adapters/codex.js';
import { MayacAdapter, type MayacAdapterOptions } from './adapters/mayac.js';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './adapters/opencode.js';

export { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions, listCldzProfiles } from './adapters/claude-code.js';
export { CodexAdapter, type CodexAdapterOptions } from './adapters/codex.js';
export { MayacAdapter, type MayacAdapterOptions, type MayacProvider } from './adapters/mayac.js';
export { OpenCodeAdapter, type OpenCodeAdapterOptions } from './adapters/opencode.js';
export { AgentBusBridge, type BusBridgeOptions, type AttachOptions } from './bus-bridge.js';
export { EventLog } from './events.js';
export { ensureMayaTeamSkill } from './skills.js';
export {
  claudeSessionExists,
  mayacSessionExists,
  planSessionArgs,
  type PlanSessionOptions,
  type SessionPlan,
} from './session-args.js';

export interface AgentRuntimeOptions {
  /** Maya gateway base — every agent's model routes through it. */
  gatewayBaseUrl: string;
}

export class AgentRuntime {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(opts: AgentRuntimeOptions) {
    this.register(new ClaudeCodeAdapter({ gatewayBaseUrl: opts.gatewayBaseUrl }));
    this.register(new CodexAdapter({ gatewayBaseUrl: opts.gatewayBaseUrl }));
    // maya code — Maya's own harness (@maya-os/code) as a first-class agent type.
    this.register(new MayacAdapter({ gatewayBaseUrl: opts.gatewayBaseUrl }));
    this.register(new OpenCodeAdapter({ gatewayBaseUrl: opts.gatewayBaseUrl }));
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
