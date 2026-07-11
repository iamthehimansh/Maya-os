/**
 * Sub-agent runner. OWNER: @agents.
 *
 * A *sub-agent* is one full run of the harness loop: a fresh `Session` (sharing
 * the parent's provider / model / auth) driven to completion on a single prompt,
 * with its final assistant text collected as the result.
 *
 * The heavy lifting lives in the existing loop — this module only:
 *   - builds a sub-session via an injected `SubSessionFactory` (so the tool need
 *     not know about provider/credentials, which `ToolContext` doesn't carry),
 *   - drains its `LoopEvent` stream into a `SubAgentResult`,
 *   - stays fully testable with a mock factory (no network).
 *
 * @core wires the concrete factory from cli.ts; foreground/background
 * orchestration and the `spawn_agent` tool sit on top of this (see spawn-tool.ts).
 */
import type { LoopEvent, Session, Tool, Usage } from '../types.js';

/**
 * Builds a fresh sub-session that shares the parent's provider / model / auth.
 * With no opts it MUST return a session whose toolset is the full merged set
 * *minus* `spawn_agent` (so a sub-agent cannot recurse into more sub-agents).
 * @core constructs this from the base loop config.
 */
export type SubSessionFactory = (opts?: {
  tools?: Tool[];
  systemPrompt?: string;
}) => Session;

export interface SubAgentResult {
  /** The sub-agent's final assistant text (trimmed). */
  text: string;
  /** Cumulative token usage for the whole sub-run. */
  usage: Usage;
  /** Cumulative cost in USD for the whole sub-run. */
  costUsd: number;
  /** True if the sub-run ended in an error (still returns any partial text). */
  isError: boolean;
  /** Error detail when `isError`. */
  errorMessage?: string;
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * Drive a session to completion on one prompt, collecting its result.
 * `onEvent` lets a caller (e.g. the background registry) observe live progress.
 */
export async function runSubAgent(
  session: Session,
  prompt: string,
  opts?: { signal?: AbortSignal; onEvent?: (ev: LoopEvent) => void },
): Promise<SubAgentResult> {
  let text = '';
  let usage: Usage = EMPTY_USAGE;
  let costUsd = 0;
  let isError = false;
  let errorMessage: string | undefined;

  const runOpts = opts?.signal ? { signal: opts.signal } : undefined;
  for await (const ev of session.run(prompt, runOpts)) {
    opts?.onEvent?.(ev);
    switch (ev.type) {
      case 'text_delta':
        text += ev.text;
        break;
      case 'usage':
        usage = ev.usage;
        costUsd = ev.costUsd;
        break;
      case 'error':
        isError = true;
        errorMessage = ev.message;
        break;
      case 'turn_end':
        usage = ev.usage;
        costUsd = ev.costUsd;
        break;
      default:
        break;
    }
  }

  return {
    text: text.trim(),
    usage,
    costUsd,
    isError,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

/** One-line preview of a prompt for labels / task lists. */
export function promptPreview(prompt: string, max = 60): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
