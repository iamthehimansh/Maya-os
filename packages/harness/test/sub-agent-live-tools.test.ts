/**
 * Regression (hardening finding #1): a sub-agent must pick up tools that register
 * AFTER it starts — e.g. a late-connecting MCP server — while never seeing
 * `spawn_agent` (recursion guard). This exercises the real createSession + loop
 * registry path: the loop reads `registry.list()` on every turn, so a shared
 * live registry (minus spawn_agent) reaches the sub-session as tools arrive.
 *
 * Uses the SHIPPED `subAgentRegistry` helper (src/agents/sub-registry.ts) that
 * cli.ts's `makeSubSession` wires in — so this tests the real seam, not a copy.
 */
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/loop/index.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { subAgentRegistry } from '../src/agents/index.js';
import type { LoopEvent, Provider, StreamEvent, StreamRequest, Tool } from '../src/types.js';

/** Records the tool names offered on each provider turn, then ends the turn. */
function recordingProvider(seen: string[][]): Provider {
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      seen.push((req.tools ?? []).map((t) => t.name));
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

const stubTool = (name: string): Tool => ({
  spec: { name, description: name, inputSchema: { type: 'object', properties: {} } },
  async run() {
    return { content: name };
  },
});

async function drain(session: ReturnType<typeof createSession>, prompt: string): Promise<void> {
  const out: LoopEvent[] = [];
  for await (const ev of session.run(prompt)) out.push(ev);
}

describe('sub-agent sees late-registered MCP tools (finding #1)', () => {
  it('picks up a tool registered after the sub-session started, and never exposes spawn_agent', async () => {
    // Shared live registry with a builtin-ish tool + spawn_agent (the recursion tool).
    const registry = createToolRegistry([stubTool('read'), stubTool('spawn_agent')]);

    // The SHIPPED sub-agent view cli.ts uses: live over the shared registry, minus spawn_agent.
    const subRegistry = subAgentRegistry(registry);

    const seen: string[][] = [];
    const session = createSession({
      provider: recordingProvider(seen),
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
      systemPrompt: 'sub-agent',
      tools: subRegistry.list(),
      registry: subRegistry,
      cwd: '/tmp',
      permission: { request: async () => true },
      authMode: 'api',
      authSource: 'test',
    });

    // Turn 1: before any MCP server has connected.
    await drain(session, 'first');
    expect(seen[0]).toContain('read');
    expect(seen[0]).not.toContain('spawn_agent'); // recursion guard

    // An MCP server connects AFTER the sub-agent started → registers into the shared registry.
    registry.register(stubTool('mcp__late__ping'));

    // Turn 2: the live view now includes the late tool, still hides spawn_agent.
    await drain(session, 'second');
    expect(seen[1]).toContain('mcp__late__ping'); // liveness ✅
    expect(seen[1]).toContain('read');
    expect(seen[1]).not.toContain('spawn_agent'); // guard still holds ✅

    // And the filtered view itself blocks spawn_agent lookups.
    expect(subRegistry.get('spawn_agent')).toBeUndefined();
    expect(subRegistry.get('mcp__late__ping')).toBeTruthy();
  });
});
