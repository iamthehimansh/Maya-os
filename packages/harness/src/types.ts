/**
 * @maya-ai/harness — the internal contract.
 *
 * This file is the ONE shared source of truth every module builds against:
 *   providers/  → implement `Provider` (translate to/from the SDKs)
 *   auth/       → implement `AuthResolver` → `Credential`
 *   loop/       → drive `Provider` + `Tool[]` into a `Session`
 *   tools/      → implement `Tool`
 *   tui/ + cli  → consume `Session` + `LoopEvent`
 *
 * Owner: @architect. Change requests: raise on the channel before editing so we
 * don't fork the contract underneath each other.
 */

import type { TaskRunner } from './tasks/index.js';

// ─────────────────────────────────────────────────────────── identifiers ────

export type ProviderId = 'anthropic' | 'openai' | (string & {});

/** User-facing auth selection. `api` → API key. `subscription` → OAuth login. */
export type AuthMode = 'api' | 'subscription';

// ─────────────────────────────────────────────── message + content model ────
//
// One provider-agnostic message format. Adapters translate this <-> the SDKs.
// The system prompt is NOT a message — it rides on the request (see StreamRequest).

export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * An image attachment carried in a user turn (drag/paste in the TUI). `data` is
 * base64-encoded bytes; `mediaType` is an image MIME type (e.g. "image/png").
 * Providers map this to their native vision block; adapters that can't render
 * images degrade to a short text placeholder.
 */
export interface ImageBlock {
  type: 'image';
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
}

/** A model's request to invoke a tool. `input` is the parsed JSON arguments. */
export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

/** The result of running a tool, fed back to the model on the next turn. */
export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock;

/** Content a caller may pass to `Session.run()` — the blocks a user turn allows. */
export type UserContentBlock = TextBlock | ImageBlock;
export type RunInput = string | UserContentBlock[];

/**
 * A conversation turn. Only `user` and `assistant` roles exist internally;
 * tool results are `tool_result` blocks carried inside a `user` message
 * (Anthropic-native shape). The OpenAI adapter fans these out to `tool` role
 * messages on its own.
 */
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

// ─────────────────────────────────────────────────────────────── tools ─────

export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: JSONSchema;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  /** Working directory the tool resolves relative paths against. */
  cwd: string;
  /** Cancels long-running tools (bash, etc.). */
  signal?: AbortSignal;
  /** Permission gate — writes/bash must await this; auto-allow for reads. */
  permission: PermissionGate;
  /** Background task runner. Present when the loop is wired to one (TUI + CLI);
   *  lets the bash tool background a long command instead of blocking the turn.
   *  Absent in bare/tool-unit contexts — the tool then runs synchronously. */
  tasks?: TaskRunner;
}

export interface Tool {
  spec: ToolSpec;
  /** `input` is the raw parsed arguments; validate against spec.inputSchema. */
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A live, mutable set of tools the loop reads on every turn. Built-ins seed it;
 * MCP servers, spawned sub-agents, monitor/cron tools register into it AFTER
 * startup and the loop picks them up on the next turn (no session rebuild).
 * Later registrations override an earlier tool of the same name.
 */
export interface ToolRegistry {
  register(tool: Tool): void;
  registerAll(tools: readonly Tool[]): void;
  /** Remove a tool by name (e.g. an MCP server disconnected). */
  unregister(name: string): void;
  /** Current tool set, stable order (insertion order, dedup by name). */
  list(): Tool[];
  get(name: string): Tool | undefined;
}

// ───────────────────────────────────────────────────────── permissions ─────

export interface PermissionRequest {
  /** Tool being invoked, e.g. "bash", "write". */
  tool: string;
  /** Short human summary of the effect, e.g. "rm -rf build" or "write src/x.ts". */
  summary: string;
  /** Optional detail (command, diff, path). */
  detail?: string;
}

/**
 * Decides whether a gated action may proceed. The loop injects one of:
 *  - an auto-allow gate (`--yolo`),
 *  - a TUI gate that prompts the user,
 *  - a headless gate (`-p` mode) that allows reads and denies writes/bash
 *    unless `--yolo`.
 */
export interface PermissionGate {
  request(req: PermissionRequest): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────── auth ──────────

/**
 * A resolved, ready-to-use credential. `token` is either an API key or an OAuth
 * access token depending on `kind`. NEVER log `token` or spread this object into
 * console output.
 */
export interface Credential {
  provider: ProviderId;
  kind: 'api' | 'oauth';
  /** Human label for the header/UI, e.g. "ANTHROPIC_API_KEY env", "macOS keychain". */
  source: string;
  /** API key or OAuth access token. */
  token: string;
  /** Extra headers the provider client must send (e.g. anthropic-beta for OAuth,
   *  chatgpt-account-id for the ChatGPT/Codex backend). */
  headers?: Record<string, string>;
  /** Override API base URL. Subscription OpenAI must target the ChatGPT/Codex
   *  backend (https://chatgpt.com/backend-api/codex) rather than api.openai.com. */
  baseUrl?: string;
  /** Epoch ms when an OAuth token expires, if known. */
  expiresAt?: number;
}

export interface AuthResolver {
  provider: ProviderId;
  /** Auth modes actually available on this machine, in preferred order. */
  detect(): Promise<AuthMode[]>;
  /**
   * Resolve a usable credential. `mode` forces api|subscription; omitted =
   * auto-detect (api-env first, then subscription).
   */
  resolve(mode?: AuthMode): Promise<Credential>;
}

// ─────────────────────────────────────────────────────── provider stream ───

export interface StreamRequest {
  model: string;
  /** System prompt (provider-agnostic string). */
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Hint the adapter to apply prompt caching where supported. */
  cache?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error';

/**
 * Normalized streaming events. Adapters MUST emit:
 *  - `text_delta` for each assistant text chunk,
 *  - exactly one `tool_call` per tool the model invokes (fully assembled input),
 *  - one `usage` (as soon as final token counts are known),
 *  - one terminal `done` with the stop reason.
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: StopReason };

export interface Provider {
  readonly id: ProviderId;
  /** Known model ids for this provider (first = default). */
  readonly models: readonly string[];
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

/** Per-provider price table ($ per 1M tokens) for the cost meter. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// ───────────────────────────────────────────────────────── agent loop ──────

/**
 * Context assembly + compaction hook (OWNER: @context). The loop calls
 * `assembleSystem()` to build each request's system prompt (base prompt + global
 * & per-project memory) and `assembleContext()` before each provider turn to
 * auto-compact history near the token limit. A no-op default is used when unset.
 */
export interface ContextManager {
  /**
   * Full system prompt for each StreamRequest: `base` prompt (the session's own,
   * so a sub-agent's custom prompt wins) with global/project memory folded in.
   * Omitting `base` falls back to the manager's configured base prompt. Cheap.
   */
  assembleSystem(base?: string): string;
  /**
   * Called before each provider turn. Auto-compacts when near the limit (or when
   * `force`). `summarize` is provided by the loop (wraps its provider) so the
   * manager can produce a synopsis without knowing about providers.
   */
  assembleContext(
    messages: readonly ModelMessage[],
    opts: { summarize: (transcript: string) => Promise<string>; force?: boolean },
  ): Promise<{ messages: ModelMessage[]; compacted?: { before: number; after: number } }>;
  estimateTokens(messages: readonly ModelMessage[]): number;
}

export interface LoopConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  /** Seed tool set. Merged into a live registry unless `registry` is supplied. */
  tools: Tool[];
  /** Live tool registry — when present the loop reads it each turn (MCP, agents). */
  registry?: ToolRegistry;
  /** Context/memory + compaction hook. No-op default when unset. */
  context?: ContextManager;
  cwd: string;
  permission: PermissionGate;
  maxTokens?: number;
  /** Token budget that triggers auto-compaction when exceeded. */
  contextLimit?: number;
  /** Fraction of contextLimit at which to compact (default 0.85). */
  compactThreshold?: number;
  /** Hard cap on tool-use turns per `send()` (safety). */
  maxTurns?: number;
}

/**
 * Events streamed out of a single `Session.run()` call. The TUI/CLI render
 * these; `usage` and `turn_end` carry running usage + cost for the meter.
 * (This is the "StreamEvent" the TUI renders — one name, defined here.)
 */
export type LoopEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'usage'; usage: Usage; costUsd: number }
  | { type: 'compacted'; before: number; after: number }
  | { type: 'error'; message: string }
  /** Terminal event for a run — the assistant is done responding this turn. */
  | { type: 'turn_end'; stopReason: StopReason; usage: Usage; costUsd: number };

/** Snapshot the TUI header/meter reads. */
export interface SessionState {
  provider: ProviderId;
  model: string;
  authMode: AuthMode;
  authSource: string;
  usage: Usage;
  costUsd: number;
  /** Approx tokens currently held in context (for the compaction indicator). */
  contextTokens: number;
}

/** Options for a single `Session.run()` call. */
export interface RunOptions {
  /**
   * Aborts the turn cleanly — cancels the provider stream and any in-flight
   * tool (via the tool's `ctx.signal`). Used by the TUI's Esc-interrupt.
   */
  signal?: AbortSignal;
}

export interface Session {
  /**
   * Run one user turn; streams assistant text, tool calls/results, then turn_end.
   * `input` is a plain string OR ordered content blocks (text + image
   * attachments) so the TUI can attach pasted/dragged images to the turn.
   */
  run(input: RunInput, opts?: RunOptions): AsyncIterable<LoopEvent>;
  /** Full transcript so far (for /clear, compaction, inspection). */
  readonly messages: readonly ModelMessage[];
  /** Live snapshot for the header/meter. */
  readonly state: SessionState;
  /**
   * Queue a message to be delivered to the model on the NEXT `run()` (e.g. a
   * cron/schedule tool firing a wake). Injected messages ride ahead of the next
   * user turn's text. Returns the pending-injection count.
   */
  inject(text: string): number;
  /** Force a compaction pass now (the `/compact` command). Returns before/after token counts, or null if nothing was compacted. */
  compact(): Promise<{ before: number; after: number } | null>;

  // ── runtime switches (slash commands) ──
  setModel(model: string): void;
  /** Swap provider (and optionally auth mode); re-resolves credentials. */
  setProvider(provider: ProviderId, mode?: AuthMode): Promise<void>;
  setAuth(mode: AuthMode): Promise<void>;
  /** Reset the transcript (keeps provider/model/auth). */
  clear(): void;
  /** Replace the transcript wholesale — used by `/resume` to reload a session. */
  loadMessages(messages: readonly ModelMessage[]): void;
}

/** Static catalog entry so `/provider` and `/model` can offer choices. */
export interface ProviderInfo {
  id: ProviderId;
  models: readonly string[];
  defaultModel: string;
}
