/**
 * The `spawn_agent` tool + `/agent` command primitive. OWNER: @agents.
 *
 *   spawn_agent — run a prompt through the harness loop as a *sub-agent*.
 *     foreground (default): blocks the tool call, returns the sub-agent's answer.
 *     background:true      : returns a handle immediately; the sub-agent runs in
 *                            the TaskRunner and shows in `/tasks`.
 *
 * A sub-agent is one fresh `Session` (see sub-agent.ts) built by an injected
 * `SubSessionFactory` — which @core constructs from the loop's base config with
 * the full toolset *minus* `spawn_agent`, so sub-agents cannot recurse.
 *
 * Nothing here touches provider/credentials directly; that keeps the tool
 * runnable in a unit test with a mock factory.
 */
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { runSubAgent, promptPreview, type SubAgentResult, type SubSessionFactory } from './sub-agent.js';
import { createAgentRegistry, type AgentRegistry } from './registry.js';

/**
 * Starts a background sub-agent and returns its handle. @core wires this to
 * `TaskRunner.register` so it appears in `/tasks`; a default in-process
 * `AgentRegistry` is used when none is injected.
 */
export type StartBackground = (
  prompt: string,
  job: (signal: AbortSignal) => Promise<SubAgentResult>,
  opts?: { label?: string },
) => { id: string };

export interface AgentToolsConfig {
  /** Build a fresh sub-session (full toolset minus `spawn_agent`). */
  makeSubSession: SubSessionFactory;
  /** Where background sub-agents run. Defaults to an internal `AgentRegistry`. */
  startBackground?: StartBackground;
  /** Max sub-agents run concurrently from ONE foreground `spawn_agent` batch. */
  maxConcurrent?: number;
}

export interface AgentTools {
  /** Tools to register into the harness registry (currently just `spawn_agent`). */
  tools: Tool[];
  /** The background registry (the fallback one, or unused if `startBackground` was injected). */
  registry: AgentRegistry;
  /** Run a foreground sub-agent directly — backs the `/agent` slash command. */
  runForeground: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<SubAgentResult>;
}

const SPAWN_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'The task for the sub-agent — a self-contained instruction. The sub-agent runs the full loop (read/write/bash/etc.) and returns its final answer.',
    },
    prompts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional: several prompts to run as sub-agents at once (foreground runs them in parallel and returns all answers). Use instead of `prompt` for a batch.',
    },
    label: { type: 'string', description: 'Optional short label for the sub-agent (shown in /tasks).' },
    background: {
      type: 'boolean',
      description:
        'If true, start the sub-agent(s) in the background and return a handle immediately (view progress in /tasks) instead of waiting for the result.',
    },
  },
} as const;

/** Turn a possibly-batch input into a clean list of prompts. */
function readPrompts(input: unknown): { prompts: string[]; label: string | undefined; background: boolean } {
  const o = (input ?? {}) as Record<string, unknown>;
  const prompts: string[] = [];
  if (typeof o.prompt === 'string' && o.prompt.trim()) prompts.push(o.prompt.trim());
  if (Array.isArray(o.prompts)) {
    for (const p of o.prompts) if (typeof p === 'string' && p.trim()) prompts.push(p.trim());
  }
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined;
  return { prompts, label, background: o.background === true };
}

/** Format one foreground sub-agent result for the parent model. */
function renderResult(r: SubAgentResult, index: number, total: number): string {
  const head = total > 1 ? `── sub-agent ${index + 1}/${total} ──\n` : '';
  if (r.isError) return `${head}[sub-agent error] ${r.errorMessage ?? 'failed'}\n${r.text}`.trimEnd();
  return `${head}${r.text}`.trimEnd();
}

export function createAgentTools(cfg: AgentToolsConfig): AgentTools {
  const registry = createAgentRegistry();
  const startBackground: StartBackground = cfg.startBackground ?? registry.start.bind(registry);
  const concurrency = Math.max(1, cfg.maxConcurrent ?? 4);

  const runForeground = (prompt: string, opts?: { signal?: AbortSignal }) => {
    const session = cfg.makeSubSession();
    return runSubAgent(session, prompt, opts?.signal ? { signal: opts.signal } : undefined);
  };

  /** Run prompts in the foreground with a small concurrency cap, preserving order. */
  async function runForegroundBatch(prompts: string[], signal?: AbortSignal): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = new Array(prompts.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= prompts.length) return;
        results[i] = await runForeground(prompts[i]!, signal ? { signal } : undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
    return results;
  }

  const spawnAgentTool: Tool = {
    spec: {
      name: 'spawn_agent',
      description:
        'Spawn a sub-agent that runs a prompt through the full harness loop and returns its answer. ' +
        'Foreground (default) waits for the result; background:true returns a handle and runs it in /tasks. ' +
        'Pass `prompts` (array) to run several at once. Use for parallelizable or well-scoped sub-tasks.',
      inputSchema: SPAWN_SCHEMA,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { prompts, label, background } = readPrompts(input);
      if (prompts.length === 0) {
        return { content: 'spawn_agent needs a non-empty `prompt` (or `prompts` array).', isError: true };
      }

      if (background) {
        const handles = prompts.map((prompt, i) => {
          const lbl = label
            ? prompts.length > 1
              ? `${label} #${i + 1}`
              : label
            : `sub-agent: ${promptPreview(prompt)}`;
          const { id } = startBackground(
            prompt,
            (signal) => runSubAgent(cfg.makeSubSession(), prompt, { signal }),
            { label: lbl },
          );
          return { id, lbl };
        });
        const lines = handles.map((h) => `• ${h.id} — ${h.lbl}`).join('\n');
        return {
          content:
            `Started ${handles.length} background sub-agent${handles.length > 1 ? 's' : ''} (view in /tasks):\n${lines}`,
        };
      }

      const results = await runForegroundBatch(prompts, ctx.signal);
      const anyError = results.some((r) => r.isError);
      const body = results.map((r, i) => renderResult(r, i, results.length)).join('\n\n');
      return { content: body, isError: anyError };
    },
  };

  return { tools: [spawnAgentTool], registry, runForeground };
}
