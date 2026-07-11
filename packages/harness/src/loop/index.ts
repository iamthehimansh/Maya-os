/**
 * Agent loop → Session factory. OWNER: @architect (loop mechanics + session
 * controls), building on @providers' Provider/Tool/auth modules.
 *
 * Implements the tool-use turn loop:
 *   provider.stream(req) → emit text deltas → collect tool_calls
 *   → run each tool (permission-gated) → feed results back → repeat
 *   until the model ends its turn (or maxTurns).
 * Plus: token+cost accounting, context auto-compaction near the limit,
 * retry/backoff on transient provider errors, and runtime provider/model/auth
 * switches for the TUI slash commands.
 */
import { createProvider, pricingFor } from '../providers/index.js';
import { resolveAuth } from '../auth/index.js';
import { createToolRegistry } from '../tools/registry.js';
import type { TaskRunner } from '../tasks/index.js';
import type {
  AuthMode,
  ContentBlock,
  LoopConfig,
  LoopEvent,
  ModelMessage,
  Provider,
  ProviderId,
  RunInput,
  Session,
  SessionState,
  StreamRequest,
  ToolCallBlock,
  ToolRegistry,
  Usage,
} from '../types.js';

export interface CreateSessionConfig extends LoopConfig {
  providerId: ProviderId;
  authMode: AuthMode;
  authSource: string;
  /** Background task runner exposed to tools (e.g. bash `background:true`). */
  tasks?: TaskRunner;
}

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_CONTEXT_LIMIT = 180_000;
const DEFAULT_COMPACT_THRESHOLD = 0.85;
const DEFAULT_MAX_TURNS = 50;
const MAX_STREAM_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for AbortController-style cancellations from the SDKs / fetch. */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'APIUserAbortError' || /abort/i.test(err.message))
  );
}

/** Cheap token estimate (~4 chars/token) for the context meter before real usage lands. */
function estimateTokens(messages: readonly ModelMessage[], system: string): number {
  let chars = system.length;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'tool_call') chars += JSON.stringify(b.input).length + b.name.length;
      else if (b.type === 'tool_result') chars += b.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

function costOf(providerId: ProviderId, model: string, u: Usage): number {
  const p = pricingFor(providerId, model);
  if (!p) return 0;
  const m = (n: number | undefined, rate: number | undefined) => ((n ?? 0) / 1_000_000) * (rate ?? 0);
  return (
    m(u.inputTokens, p.input) +
    m(u.outputTokens, p.output) +
    m(u.cacheReadTokens, p.cacheRead) +
    m(u.cacheWriteTokens, p.cacheWrite)
  );
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

class SessionImpl implements Session {
  messages: ModelMessage[] = [];
  private provider: Provider;
  private providerId: ProviderId;
  private model: string;
  private authMode: AuthMode;
  private authSource: string;
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private cumulativeCost = 0;
  private lastContextTokens = 0;
  private readonly cfg: CreateSessionConfig;
  /** Live tool set — read on every turn so post-startup tools (MCP, agents) land. */
  private readonly registry: ToolRegistry;
  /** Messages queued by `inject()` (cron/schedule wakes), flushed on next run(). */
  private readonly pendingInjections: string[] = [];

  constructor(cfg: CreateSessionConfig) {
    this.cfg = cfg;
    this.provider = cfg.provider;
    this.providerId = cfg.providerId;
    this.model = cfg.model;
    this.authMode = cfg.authMode;
    this.authSource = cfg.authSource;
    // A shared registry from the caller wins (so MCP/agent tools registered into
    // it are visible); otherwise seed a private one from the static tool list.
    this.registry = cfg.registry ?? createToolRegistry(cfg.tools);
  }

  /** Current tool set the loop drives this turn. */
  private tools() {
    return this.registry.list();
  }

  get state(): SessionState {
    return {
      provider: this.providerId,
      model: this.model,
      authMode: this.authMode,
      authSource: this.authSource,
      usage: this.cumulativeUsage,
      costUsd: this.cumulativeCost,
      contextTokens: this.lastContextTokens,
    };
  }

  get costUsd(): number {
    return this.cumulativeCost;
  }

  get usage(): Usage {
    return this.cumulativeUsage;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async setProvider(provider: ProviderId, mode?: AuthMode): Promise<void> {
    const cred = await resolveAuth(provider, mode);
    this.provider = createProvider(provider, cred);
    this.providerId = provider;
    this.authMode = cred.kind === 'api' ? 'api' : 'subscription';
    this.authSource = cred.source;
    this.model = this.provider.models[0] ?? this.model;
  }

  async setAuth(mode: AuthMode): Promise<void> {
    const cred = await resolveAuth(this.providerId, mode);
    this.provider = createProvider(this.providerId, cred);
    this.authMode = cred.kind === 'api' ? 'api' : 'subscription';
    this.authSource = cred.source;
  }

  clear(): void {
    this.messages = [];
    this.lastContextTokens = 0;
  }

  loadMessages(messages: readonly ModelMessage[]): void {
    // Deep-ish copy so callers can't mutate our transcript out from under us.
    this.messages = messages.map((m) => ({ role: m.role, content: [...m.content] }));
    this.lastContextTokens = estimateTokens(this.messages, this.cfg.systemPrompt);
  }

  private systemPrompt(): string {
    // Pass the session's own base prompt so a sub-agent's custom systemPrompt
    // wins; @context folds global+project memory into whatever base it receives.
    return this.cfg.context ? this.cfg.context.assembleSystem(this.cfg.systemPrompt) : this.cfg.systemPrompt;
  }

  private buildRequest(signal?: AbortSignal): StreamRequest {
    return {
      model: this.model,
      system: this.systemPrompt(),
      messages: this.messages,
      tools: this.tools().map((t) => t.spec),
      maxTokens: this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      cache: true,
      ...(signal ? { signal } : {}),
    };
  }

  inject(text: string): number {
    this.pendingInjections.push(text);
    return this.pendingInjections.length;
  }

  async compact(): Promise<{ before: number; after: number } | null> {
    let result: { before: number; after: number } | null = null;
    for await (const ev of this.maybeCompact(true)) {
      if (ev.type === 'compacted') result = { before: ev.before, after: ev.after };
    }
    return result;
  }

  /** One provider streaming turn with retry/backoff. Yields provider StreamEvents. */
  private async *streamTurn(signal?: AbortSignal): AsyncGenerator<
    { text: string } | { toolCall: ToolCallBlock } | { usage: Usage } | { done: import('../types.js').StopReason }
  > {
    for (let attempt = 0; ; attempt++) {
      try {
        const req = this.buildRequest(signal);
        for await (const ev of this.provider.stream(req)) {
          if (ev.type === 'text_delta') yield { text: ev.text };
          else if (ev.type === 'tool_call') yield { toolCall: { type: 'tool_call', id: ev.id, name: ev.name, input: ev.input } };
          else if (ev.type === 'usage') yield { usage: ev.usage };
          else if (ev.type === 'done') yield { done: ev.stopReason };
        }
        return;
      } catch (err) {
        // Never retry an interrupt — surface it immediately.
        if (signal?.aborted || isAbortError(err)) throw err;
        if (attempt >= MAX_STREAM_RETRIES) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  async *run(input: RunInput, opts?: import('../types.js').RunOptions): AsyncIterable<LoopEvent> {
    const signal = opts?.signal;
    // Deliver any queued wakes (cron/schedule) ahead of this turn.
    for (const inj of this.pendingInjections.splice(0)) {
      this.messages.push({ role: 'user', content: [{ type: 'text', text: inj }] });
    }
    const content: ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : input.map((b) => b);
    this.messages.push({ role: 'user', content });

    const maxTurns = this.cfg.maxTurns ?? DEFAULT_MAX_TURNS;
    let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal?.aborted) {
          yield { type: 'turn_end', stopReason: 'stop', usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
          return;
        }
        yield* this.maybeCompact();

        // Ordered assistant blocks: text is split into separate blocks around each
        // tool call, so `text → tool → text → tool` survives verbatim into the
        // transcript AND the live event stream (tool_call is emitted the moment the
        // provider yields it, interleaved with text_delta — not buffered to the end).
        const assistantBlocks: ContentBlock[] = [];
        const toolCalls: ToolCallBlock[] = [];
        let stopReason: import('../types.js').StopReason = 'end_turn';
        let curText = '';
        const flushText = () => {
          if (curText) {
            assistantBlocks.push({ type: 'text', text: curText });
            curText = '';
          }
        };

        for await (const ev of this.streamTurn(signal)) {
          if ('text' in ev) {
            curText += ev.text;
            yield { type: 'text_delta', text: ev.text };
          } else if ('toolCall' in ev) {
            // Close the text run that preceded this call, then record + emit it now.
            flushText();
            assistantBlocks.push(ev.toolCall);
            toolCalls.push(ev.toolCall);
            yield { type: 'tool_call', id: ev.toolCall.id, name: ev.toolCall.name, input: ev.toolCall.input };
          } else if ('usage' in ev) {
            turnUsage = addUsage(turnUsage, ev.usage);
            this.cumulativeUsage = addUsage(this.cumulativeUsage, ev.usage);
            const c = costOf(this.providerId, this.model, ev.usage);
            this.cumulativeCost += c;
            this.lastContextTokens = ev.usage.inputTokens + ev.usage.outputTokens;
            yield { type: 'usage', usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
          } else if ('done' in ev) {
            stopReason = ev.done;
          }
        }

        flushText();
        if (assistantBlocks.length) this.messages.push({ role: 'assistant', content: assistantBlocks });

        if (toolCalls.length === 0) {
          yield { type: 'turn_end', stopReason, usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
          return;
        }

        // Tool calls were already emitted (in order) above; now run them and feed
        // results back as one user message. Results attach to their call by id.
        const resultBlocks: ContentBlock[] = [];
        for (const tc of toolCalls) {
          const tool = this.registry.get(tc.name);
          let output: string;
          let isError = false;
          if (signal?.aborted) {
            output = 'Interrupted by user before the tool ran.';
            isError = true;
          } else if (!tool) {
            output = `Unknown tool: ${tc.name}`;
            isError = true;
          } else {
            try {
              const res = await tool.run(tc.input, {
                cwd: this.cfg.cwd,
                permission: this.cfg.permission,
                ...(this.cfg.tasks ? { tasks: this.cfg.tasks } : {}),
                ...(signal ? { signal } : {}),
              });
              output = res.content;
              isError = res.isError ?? false;
            } catch (err) {
              output = err instanceof Error ? err.message : String(err);
              isError = true;
            }
          }
          resultBlocks.push({ type: 'tool_result', toolCallId: tc.id, content: output, isError });
          yield { type: 'tool_result', id: tc.id, output, isError };
        }
        this.messages.push({ role: 'user', content: resultBlocks });

        if (signal?.aborted) {
          yield { type: 'turn_end', stopReason: 'stop', usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
          return;
        }
      }

      // Hit the turn cap.
      yield { type: 'error', message: `Stopped after ${maxTurns} tool-use turns.` };
      yield { type: 'turn_end', stopReason: 'max_tokens', usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
    } catch (err) {
      // An interrupt is not an error — end the turn cleanly.
      if (signal?.aborted || isAbortError(err)) {
        yield { type: 'turn_end', stopReason: 'stop', usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
        return;
      }
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      yield { type: 'turn_end', stopReason: 'error', usage: this.cumulativeUsage, costUsd: this.cumulativeCost };
    }
  }

  /** Summarize old history via the provider — shared by the default path and @context's hook. */
  private summarize = async (transcript: string): Promise<string> => {
    let summary = '';
    try {
      const req: StreamRequest = {
        model: this.model,
        system:
          'Summarize the following coding-session transcript into a concise brief that preserves file paths, decisions, and open tasks. Output only the summary.',
        messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
        maxTokens: 1024,
      };
      for await (const ev of this.provider.stream(req)) {
        if (ev.type === 'text_delta') summary += ev.text;
      }
    } catch {
      /* fall through to the truncation fallback below */
    }
    return summary || '[Earlier conversation truncated to fit context.]';
  };

  /**
   * Compact old history near the token limit (or when `force`). Delegates to the
   * @context ContextManager when wired; otherwise uses the built-in strategy
   * (keep the last exchange, summarize the rest).
   */
  private async *maybeCompact(force = false): AsyncGenerator<LoopEvent> {
    if (this.cfg.context) {
      const res = await this.cfg.context.assembleContext(this.messages, {
        summarize: this.summarize,
        force,
      });
      this.messages = res.messages;
      if (res.compacted) {
        this.lastContextTokens = res.compacted.after;
        yield { type: 'compacted', before: res.compacted.before, after: res.compacted.after };
      }
      return;
    }

    const limit = this.cfg.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    const threshold = (this.cfg.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD) * limit;
    const est = this.lastContextTokens || estimateTokens(this.messages, this.cfg.systemPrompt);
    if ((!force && est < threshold) || this.messages.length <= 2) return;

    const before = est;
    // Keep the last exchange verbatim; summarize everything before it.
    const keep = this.messages.slice(-2);
    const summary = await this.summarize(transcriptText(this.messages.slice(0, -2)));
    this.messages = [
      { role: 'user', content: [{ type: 'text', text: `Conversation summary so far:\n${summary}` }] },
      ...keep,
    ];
    const after = estimateTokens(this.messages, this.cfg.systemPrompt);
    this.lastContextTokens = after;
    yield { type: 'compacted', before, after };
  }
}

function transcriptText(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`${m.role}: ${b.text}`);
      else if (b.type === 'tool_call') lines.push(`${m.role} calls ${b.name}(${JSON.stringify(b.input)})`);
      else if (b.type === 'tool_result') lines.push(`tool_result: ${b.content.slice(0, 500)}`);
    }
  }
  return lines.join('\n');
}

export function createSession(config: CreateSessionConfig): Session {
  return new SessionImpl(config);
}
