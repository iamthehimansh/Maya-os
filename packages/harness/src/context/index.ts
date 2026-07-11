/**
 * Context manager — the hook @core calls each turn so memory + compaction plug
 * into every session transparently. OWNER: @context.
 *
 *   assembleSystem()  → base system prompt + rendered global/project memory.
 *   assembleContext() → auto-compact the transcript when it nears the token
 *                       limit (or on `force` for `/compact`), keeping recent
 *                       turns verbatim and summarizing the rest.
 *   estimateTokens()  → cheap ~4-chars/token estimate incl. the system prompt.
 *
 * Compaction is tool-call-safe: the verbatim tail never begins with a
 * `tool_result` whose originating `tool_call` was summarized away (which the
 * Anthropic API rejects) — we snap the cut back to a clean user turn.
 *
 * No provider/Ink deps: the caller supplies a `summarize(transcript)` callback
 * built from its provider, so this module is pure and unit-testable.
 */
import { loadMemory, renderMemory, type LoadedMemory } from '../memory/index.js';
import type {
  ContentBlock,
  ContextManager as BaseContextManager,
  ModelMessage,
  SessionState,
  Tool,
  ToolResult,
} from '../types.js';

/** Turns a transcript into a concise synopsis. Supplied by the loop (its provider). */
export type Summarize = (transcript: string) => Promise<string>;

export interface ContextManagerOptions {
  /** The base system prompt (before memory is folded in). */
  basePrompt: string;
  /** Working directory — roots project-memory discovery. */
  cwd: string;
  /** Token budget that triggers auto-compaction. Default 180_000. */
  contextLimit?: number;
  /** Fraction of contextLimit at which to auto-compact. Default 0.85. */
  compactThreshold?: number;
  /** How many trailing messages to keep verbatim through a compaction. Default 6. */
  keepRecent?: number;
  /** Override the global-memory dir (tests). */
  globalDir?: string;
  /** Preloaded memory (skips disk); otherwise `load()` reads it. */
  memory?: LoadedMemory;
}

export interface AssembleContextResult {
  /** The (possibly compacted) message list to run this turn. */
  messages: ModelMessage[];
  /** Present iff compaction happened — before/after token estimates. */
  compacted?: { before: number; after: number };
}

/**
 * The concrete manager: the canonical `ContextManager` contract (types.ts, so
 * the loop can hold it) plus two conveniences the TUI/CLI use — `load()` to read
 * memory from disk and a `memory` snapshot for `/memory` + the context meter.
 */
export interface ContextManager extends BaseContextManager {
  /**
   * Full system prompt for a request: memory folded into `base` (defaults to the
   * configured prompt). The loop passes the session's own prompt so a sub-agent's
   * custom system prompt wins while still inheriting memory.
   */
  assembleSystem(base?: string): string;
  /** Load memory from disk once (no-op if already loaded / preloaded). */
  load(): Promise<void>;
  /** Force a re-read of memory from disk (after `/memory add` or an edit). */
  reload(): Promise<void>;
  /** Loaded memory snapshot (for `/memory` + the context meter). */
  readonly memory: LoadedMemory;
}

const DEFAULT_CONTEXT_LIMIT = 180_000;
const DEFAULT_COMPACT_THRESHOLD = 0.85;
const DEFAULT_KEEP_RECENT = 6;
const EMPTY_MEMORY: LoadedMemory = { files: [], chars: 0 };

/** A vision block costs ~1200 tokens regardless of byte size; ~4 chars/token. */
const IMAGE_CHARS = 1200 * 4;

/** Approx tokens for a block, ~4 chars/token. */
function blockChars(b: ContentBlock): number {
  if (b.type === 'text') return b.text.length;
  if (b.type === 'image') return IMAGE_CHARS;
  if (b.type === 'tool_call') return JSON.stringify(b.input).length + b.name.length;
  return b.content.length; // tool_result
}

/**
 * A safe place to begin the verbatim tail: any message EXCEPT a `user` message
 * carrying `tool_result` blocks — those reference a `tool_call` we'd summarize
 * away, which the Anthropic API rejects. An `assistant(tool_call)` at the head is
 * fine: its matching `tool_result` sits later in the same tail.
 */
function isSafeCutStart(m: ModelMessage): boolean {
  return !(m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
}

/** Flatten messages to a plain transcript for the summarizer. */
export function transcriptText(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`${m.role}: ${b.text}`);
      else if (b.type === 'tool_call') lines.push(`${m.role} calls ${b.name}(${JSON.stringify(b.input)})`);
      else if (b.type === 'tool_result') lines.push(`tool_result: ${b.content.slice(0, 800)}`);
    }
  }
  return lines.join('\n');
}

class ContextManagerImpl implements ContextManager {
  private readonly basePrompt: string;
  private readonly cwd: string;
  private readonly contextLimit: number;
  private readonly compactThreshold: number;
  private readonly keepRecent: number;
  private readonly globalDir: string | undefined;
  private mem: LoadedMemory;
  private loaded: boolean;
  /** Cached rendered-memory section (recomputed on load/reload). */
  private cachedMemSection: string | null = null;

  constructor(o: ContextManagerOptions) {
    this.basePrompt = o.basePrompt;
    this.cwd = o.cwd;
    this.contextLimit = o.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    this.compactThreshold = o.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.keepRecent = o.keepRecent ?? DEFAULT_KEEP_RECENT;
    this.globalDir = o.globalDir;
    this.mem = o.memory ?? EMPTY_MEMORY;
    this.loaded = o.memory !== undefined;
  }

  get memory(): LoadedMemory {
    return this.mem;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.mem = await loadMemory(this.cwd, this.globalDir ? { globalDir: this.globalDir } : {});
    this.cachedMemSection = null;
  }

  async reload(): Promise<void> {
    this.mem = await loadMemory(this.cwd, this.globalDir ? { globalDir: this.globalDir } : {});
    this.loaded = true;
    this.cachedMemSection = null;
  }

  /**
   * Full system prompt for a request: memory folded into `base`. `base` defaults
   * to the manager's configured prompt, but the loop passes the SESSION's own
   * prompt so a sub-agent's custom system prompt still wins while inheriting
   * memory. Only the memory section is cached; composition is cheap per-call.
   */
  assembleSystem(base?: string): string {
    if (this.cachedMemSection === null) this.cachedMemSection = renderMemory(this.mem);
    const b = base ?? this.basePrompt;
    return this.cachedMemSection ? `${b}\n\n${this.cachedMemSection}` : b;
  }

  estimateTokens(messages: readonly ModelMessage[]): number {
    let chars = this.assembleSystem().length;
    for (const m of messages) for (const b of m.content) chars += blockChars(b);
    return Math.ceil(chars / 4);
  }

  async assembleContext(
    messages: readonly ModelMessage[],
    opts: { summarize: Summarize; force?: boolean },
  ): Promise<AssembleContextResult> {
    const before = this.estimateTokens(messages);
    const threshold = this.compactThreshold * this.contextLimit;
    const shouldCompact = opts.force || before >= threshold;
    if (!shouldCompact || messages.length <= 2) {
      return { messages: messages as ModelMessage[] };
    }

    // Choose a verbatim tail, snapped back to a clean user turn so we never
    // orphan a tool_result from its tool_call.
    let cut = Math.max(0, messages.length - this.keepRecent);
    while (cut > 0 && !isSafeCutStart(messages[cut]!)) cut--;
    if (cut === 0) {
      // Nothing safe to summarize (whole convo is one tool chain) — leave as-is.
      return { messages: messages as ModelMessage[] };
    }

    const toSummarize = messages.slice(0, cut);
    const keep = messages.slice(cut);
    let summary: string;
    try {
      summary = (await opts.summarize(transcriptText(toSummarize))).trim();
    } catch {
      summary = '[Earlier conversation truncated to fit the context window.]';
    }
    if (!summary) summary = '[Earlier conversation truncated to fit the context window.]';

    const compacted: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: `Summary of the earlier conversation:\n${summary}` }] },
      ...keep.map((m) => ({ role: m.role, content: [...m.content] })),
    ];
    const after = this.estimateTokens(compacted);
    return { messages: compacted, compacted: { before, after } };
  }
}

export function createContextManager(o: ContextManagerOptions): ContextManager {
  return new ContextManagerImpl(o);
}

// ──────────────────────────────────────────────────────── compact tool ──────

/**
 * The slice of `Session` the `compact` tool needs: force a compaction and read
 * the current context size. A structural type so tests can pass a light stub.
 */
export interface Compactable {
  /** Force a compaction now; before/after token estimates, or null if nothing compacted. */
  compact(): Promise<{ before: number; after: number } | null>;
  /** Live session snapshot (for the no-op token count). */
  readonly state: SessionState;
}

/**
 * `compact` — lets the AGENT trigger context compaction mid-task, the same
 * summarize-old-turns pass as the user's `/compact`. Returns the before/after
 * token counts so the model can see how much room it freed. Registered as a
 * factory over the live session so it drives the SAME compaction path — no
 * separate strategy to drift.
 *
 * Compacting mid-turn is tool-safe: the assistant message carrying THIS tool's
 * call is the transcript tail, so it (and its forthcoming tool_result) is always
 * kept verbatim — never summarized away and orphaned.
 */
export function createCompactTool(session: Compactable): Tool {
  return {
    spec: {
      name: 'compact',
      description:
        'Compact your own conversation context: summarize older turns to free up ' +
        'the token budget while keeping recent turns verbatim. Use when the context ' +
        'is getting full mid-task. Returns the before/after token counts. Takes no arguments.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(): Promise<ToolResult> {
      try {
        const res = await session.compact();
        if (!res) {
          return {
            content: `Nothing to compact — context is already minimal (~${session.state.contextTokens} tokens).`,
          };
        }
        const saved = res.before - res.after;
        return {
          content: `Compacted context: ${res.before} → ${res.after} tokens (freed ~${saved}).`,
        };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  };
}

/** The default summarizer instruction — the loop pairs this with its provider. */
export const SUMMARIZE_INSTRUCTION =
  'Summarize the following coding-session transcript into a concise brief that ' +
  'preserves file paths, key decisions, code changes made, and any open tasks. ' +
  'Write in past tense as durable context for continuing the work. Output only the summary.';
