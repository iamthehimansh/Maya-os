/**
 * Anthropic provider adapter. OWNER: @providers.
 *
 * `stream(req)` drives @anthropic-ai/sdk's Messages API (streaming) and maps SDK
 * events → StreamEvent (text_delta / tool_call / usage / done). Translation:
 *   ModelMessage[]  -> messages (tool_result blocks ride inside user turns)
 *   ToolSpec[]      -> tools (name/description/input_schema)
 *   system string   -> system param
 *
 * Auth:
 *   kind='api'   → apiKey (x-api-key header).
 *   kind='oauth' → Bearer authToken + cred.headers (anthropic-beta oauth), and the
 *                  system prompt MUST begin with the Claude Code identity block or
 *                  the API rejects OAuth tokens. We prepend it here so the loop
 *                  stays provider-agnostic.
 * Never log cred.token.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ImageBlockParam,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Credential,
  ModelMessage,
  Provider,
  StopReason,
  StreamEvent,
  StreamRequest,
  ToolSpec,
  Usage,
} from '../types.js';
import { PROVIDER_CATALOG } from './index.js';

/** Required leading identity so the Messages API accepts a Claude Code OAuth token. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const DEFAULT_MAX_TOKENS = 8192;

/**
 * The Anthropic **subscription** (OAuth) Messages endpoint reserves the tool-name
 * prefix `mcp_` (a single underscore) and rejects any request whose tool list —
 * or history tool_use blocks — contains such a name, with the *misleading* 400
 * `You're out of extra usage. Add more at claude.ai/settings/usage.` (verified
 * live: `mcp_connect`/`mcp_server`/`mcp_tool` all 400; `mcpconnect`/`connect_mcp`
 * pass). The double-underscore `mcp__server__tool` form — the real MCP tool
 * convention — is EXEMPT, so we only touch single-underscore `mcp_` names.
 *
 * Fix: on the OAuth path, rename such tools to a wire-safe `mcp-…` on the way
 * out (both in the tools list and in assistant tool_use blocks) and map the
 * model's returned tool_call name back so the loop's registry lookup still finds
 * the original tool. API-key requests are left untouched.
 */
const RESERVED_TOOL_PREFIX = /^mcp_(?!_)/;

/** Wire-safe rename for an OAuth request; identity for non-reserved names. */
export function oauthSafeToolName(name: string): string {
  return RESERVED_TOOL_PREFIX.test(name) ? `mcp-${name.slice(4)}` : name;
}

function buildClient(cred: Credential): Anthropic {
  const opts: ConstructorParameters<typeof Anthropic>[0] = {
    ...(cred.headers ? { defaultHeaders: cred.headers } : {}),
    // We drive our own retry/backoff in the loop; keep the SDK from double-retrying.
    maxRetries: 2,
  };
  if (cred.kind === 'oauth') {
    // Bearer auth, NOT x-api-key. Passing an empty apiKey stops the SDK from
    // reading ANTHROPIC_API_KEY out of the env and sending it alongside.
    opts.authToken = cred.token;
    opts.apiKey = null;
  } else {
    opts.apiKey = cred.token;
  }
  return new Anthropic(opts);
}

export function toAnthropicMessages(
  messages: readonly ModelMessage[],
  nameFor: (name: string) => string = (n) => n,
): MessageParam[] {
  return messages.map((m) => {
    const content = m.content.map((b) => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text } satisfies TextBlockParam;
        case 'image':
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: b.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: b.data,
            },
          } satisfies ImageBlockParam;
        case 'tool_call':
          return {
            type: 'tool_use',
            id: b.id,
            name: nameFor(b.name),
            input: (b.input ?? {}) as Record<string, unknown>,
          } satisfies ToolUseBlockParam;
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: b.toolCallId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          } satisfies ToolResultBlockParam;
      }
    });
    return { role: m.role, content };
  });
}

export function toAnthropicTools(
  tools: readonly ToolSpec[],
  cache: boolean,
  nameFor: (name: string) => string = (n) => n,
): AnthropicTool[] {
  return tools.map((t, i) => {
    const last = i === tools.length - 1;
    return {
      name: nameFor(t.name),
      description: t.description,
      input_schema: t.inputSchema as AnthropicTool['input_schema'],
      // Cache the (stable) tool definitions by marking the final one.
      ...(cache && last ? { cache_control: { type: 'ephemeral' } } : {}),
    };
  });
}

/** Build the system param, injecting the Claude Code identity for OAuth tokens. */
export function buildSystem(
  system: string | undefined,
  isOAuth: boolean,
  cache: boolean,
): string | TextBlockParam[] | undefined {
  const blocks: TextBlockParam[] = [];
  if (isOAuth) blocks.push({ type: 'text', text: CLAUDE_CODE_IDENTITY });
  if (system) blocks.push({ type: 'text', text: system });
  if (blocks.length === 0) return undefined;
  // Simple, robust caching: mark the last system block ephemeral when asked.
  if (cache) {
    const lastBlock = blocks[blocks.length - 1]!;
    lastBlock.cache_control = { type: 'ephemeral' };
  }
  // A single plain block with no cache can stay a bare string.
  if (blocks.length === 1 && !cache) return blocks[0]!.text;
  return blocks;
}

export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case null:
    case undefined:
      return 'end_turn';
    default:
      return 'stop';
  }
}

export function createAnthropicProvider(cred: Credential): Provider {
  const client = buildClient(cred);
  const isOAuth = cred.kind === 'oauth';

  return {
    id: 'anthropic',
    models: PROVIDER_CATALOG.anthropic!.models,
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      const cache = req.cache ?? true;
      const system = buildSystem(req.system, isOAuth, cache);
      // On the OAuth (subscription) path, rewrite reserved `mcp_` tool names to a
      // wire-safe form and remember the reverse so a tool_call is restored to the
      // real name before the loop looks it up. Identity map for API-key requests.
      const nameFor = isOAuth ? oauthSafeToolName : (n: string) => n;
      const restoreName = new Map<string, string>();
      if (isOAuth) {
        for (const t of req.tools ?? []) {
          const wire = nameFor(t.name);
          if (wire !== t.name) restoreName.set(wire, t.name);
        }
      }
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(system !== undefined ? { system } : {}),
          messages: toAnthropicMessages(req.messages, nameFor),
          ...(req.tools && req.tools.length > 0
            ? { tools: toAnthropicTools(req.tools, cache, nameFor) }
            : {}),
        },
        req.signal ? { signal: req.signal } : {},
      );

      // Assemble tool_use input JSON across input_json_delta chunks, keyed by
      // content-block index.
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = 'end_turn';

      for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            usage.inputTokens = u.input_tokens ?? 0;
            usage.outputTokens = u.output_tokens ?? 0;
            if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens != null)
              usage.cacheWriteTokens = u.cache_creation_input_tokens;
            break;
          }
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              toolBlocks.set(event.index, { id: block.id, name: block.name, json: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'input_json_delta') {
              const tb = toolBlocks.get(event.index);
              if (tb) tb.json += delta.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            const tb = toolBlocks.get(event.index);
            if (tb) {
              let input: unknown = {};
              try {
                input = tb.json.trim() ? JSON.parse(tb.json) : {};
              } catch {
                input = {};
              }
              yield {
                type: 'tool_call',
                id: tb.id,
                name: restoreName.get(tb.name) ?? tb.name,
                input,
              };
              toolBlocks.delete(event.index);
            }
            break;
          }
          case 'message_delta': {
            if (event.usage?.output_tokens != null) usage.outputTokens = event.usage.output_tokens;
            stopReason = mapStopReason(event.delta.stop_reason);
            break;
          }
          case 'message_stop':
            break;
        }
      }

      yield { type: 'usage', usage };
      yield { type: 'done', stopReason };
    },
  };
}
